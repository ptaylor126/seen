import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import {
    FilmStrip,
    PaperPlaneTilt,
    Star,
    StarHalf,
    X,
} from 'phosphor-react-native';
import { MotiView } from 'moti';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
    Alert,
    Modal,
    PanResponder,
    Pressable,
    ScrollView,
    StyleSheet,
    useColorScheme,
    useWindowDimensions,
    View,
    type StyleProp,
    type ViewStyle,
} from 'react-native';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Reanimated, {
    Easing,
    interpolate,
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
    type SharedValue,
} from 'react-native-reanimated';
import {
    initialWindowMetrics,
    SafeAreaProvider,
    useSafeAreaInsets,
} from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { Text } from '@/components/text';
import { TextInput } from '@/components/text-input';
import { Toggle } from '@/components/toggle';
import { postRecComment } from '@/lib/comments';
import { setItemVisibility } from '@/lib/item-status';
import { applyWatchedRating, ratingGlyphs, type MediaType } from '@/lib/rating';
import { getReceivedRecsForTitle, type ReceivedRec } from '@/lib/recs';
import { maybeRequestReviewAfterRecRating } from '@/lib/review';
import supabase from '@/lib/supabase';
import { fetchTitlesByItems } from '@/lib/titles';
import { imageUrl } from '@/lib/tmdb';
import {
    button,
    getPalette,
    onImage,
    posterFrame,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

interface RatingSheetProps {
    visible: boolean;
    busy: boolean;
    // Pre-fill the stars with an existing rating. The rating is stored
    // on the half-star 1-10 scale (1 = ½★, 2 = 1★, …, 10 = 5★). Null
    // means no pre-selection.
    initialRating: number | null;
    // Title identity — used on open to look up the recs the current user
    // received for it (the post-watched rec-case fork) and, later, to save the
    // note. Null when unknown → the sheet behaves as the no-rec case.
    tmdbId: number | null;
    mediaType: MediaType | null;
    // Called with the chosen 1-10 rating when the user taps Done, or
    // null when they dismissed without committing (the close X or
    // hardware back).
    onSubmit: (rating: number | null) => void;
}

// Note length cap — matches the rec comment composer's cap, since in the rec
// case the note becomes a recommendation_comments body.
const NOTE_MAX = 500;

const STAR_COUNT = 5;
const HALF_COUNT = STAR_COUNT * 2; // = 10
// Distance (in px) the finger must travel before the row-level
// PanResponder claims the gesture from the per-half Pressables.
// Below: a tap, the Pressable handles it. Above: a drag.
const DRAG_THRESHOLD_PX = 5;

// Open/close motion: the whole screen CROSS-FADES on one shared `progress`
// value — no slide. Opened from the title page (whose hero is the same
// backdrop), a fade reads as that hero turning into the rating screen;
// a slide-up read as a second surface arriving over a duplicate image.
// Keyboard-aware: the control column's bottom padding rides the keyboard so
// the controls lift above it, on the same react-native-keyboard-controller
// scaffold as before.
const OPEN_MS = 240;
const CLOSE_MS = 180;
// Max time to wait for the received-recs lookup before opening anyway. Fetch-
// before-open: the screen fades in already knowing rec vs no-rec at its true
// final layout, so nothing settles after the fade. Past this cap (slow fetch)
// it opens in the no-rec layout and the rec section appears when the fetch
// lands — a rare fallback.
const OPEN_MAX_WAIT_MS = 150;

// ─── Backdrop treatment ────────────────────────────────────────────────
// Three tuning values, deliberately named and grouped: this is the balance
// between "how much image you see" and "can you read the controls over it",
// and it's the part most likely to want an on-device nudge.
//
// IMAGE_DIM       a flat wash of palette.bg over the WHOLE image, so even
//                 the clear top of the frame is knocked back from a raw
//                 photo — stops a bright backdrop fighting the close X.
// GRADIENT_START  where the vertical ramp begins (fraction of screen
//                 height). Above this the image carries only IMAGE_DIM.
// GRADIENT_SOLID  where the ramp reaches solid palette.bg. Below this the
//                 controls sit on flat ground.
// The ramp itself is the bgTransparent → bg PURE-ALPHA pair; a
// 'transparent' → bg ramp greys the midpoint (same seam lesson as the
// title/rec heroes).
const IMAGE_DIM = 0.2;
const GRADIENT_START = 0.1;
const GRADIENT_SOLID = 0.58;
// Backdrop blur. The image is atmosphere, not subject — the sharp POSTER
// below carries the title's identity — so blurring it lets the controls sit
// on it without fighting detail, and lets IMAGE_DIM come down (0.28 → 0.2)
// because there's no fine detail left to compete with text. Blurring also
// means the source can drop a rung: w780 upscaled and blurred is
// indistinguishable from w1280 blurred, at ~40% of the bytes.
const BACKDROP_BLUR = 25;
// Poster — the hero. Sharp (never blurred): it's the one crisp anchor
// identifying what's being rated. 2:3, sized to whatever vertical room is
// left after the rest of the no-rec layout, so that mode never scrolls.
// See posterWidthFor().
const POSTER_MAX_W = 150;
// Floor, not the usual size: the budget below normally yields more. It only
// binds on a very short screen, where a floor ABOVE the computed fit would
// override the calculation and reintroduce the scroll it exists to prevent.
const POSTER_MIN_W = 84;
const POSTER_ASPECT = 1.5; // height / width, i.e. 2:3
// Close button — matches the title page's (36pt circle, onImage.chip fill,
// inset + base from the top) so the chrome is identical between the two
// screens. Also the height the control column reserves at the top so a
// scrolling layout never runs under it.
const CLOSE_BUTTON_SIZE = 36;
// "Loved it? Send it to a friend" — fades rather than mounts as the rating
// crosses 4 stars, so the line's height is reserved at ALL ratings and
// nothing below it moves when you drag across the threshold.
const RECOMMEND_FADE_MS = 200;
// Everything in the no-rec scroll content EXCEPT the poster: the content
// container's top padding (24), the identity group's poster→title gap (12)
// and title block (headingDisplay 28 + xs 4 + caption 18), the lg gap
// between the two groups (24), and the action group (question 32 + md 12 +
// stars row 60 + md 12 + recommend line 22 + md 12 + toggle row 28). Kept
// as a named total because it's the input to the poster sizing.
//
// Budgets the title AND the question at ONE line each. Either wrapping to
// two adds its line height (28 / 32) and can tip a small screen into a
// short scroll. Budgeting two lines instead would shrink the poster for
// everyone to serve the rarer case.
const NO_REC_CONTENT_H =
    24 + (12 + 28 + 4 + 18) + 24 + (32 + 12 + 60 + 12 + 22 + 12 + 28);
// The pinned bottom stack: lg padding + the "Write a review" link (body 22)
// + lg gap + Done 54. Skip and the outlined Recommend button are gone —
// closing is the top-left X, recommending moved under the stars.
const BOTTOM_STACK_H = 24 + 22 + 24 + 54;
// Slack so rounding and font-metric variance can't tip no-rec into a 1pt
// scroll.
const POSTER_FIT_BUFFER = 8;

// Largest 2:3 poster that still lets no-rec mode fit without scrolling on
// this screen, clamped either side. Needs the REAL insets, so it's called
// from ContentColumn (inside the modal's SafeAreaProvider) — see there.
// Takes the ALREADY-COMPUTED top inset rather than raw insets.top, so this
// and the control column's paddingTop can't drift apart — they have to
// agree or the budget is sizing against a different box than the one the
// content lands in.
function posterWidthFor(
    windowHeight: number,
    contentTopInset: number,
    insetBottom: number,
): number {
    const available =
        windowHeight -
        contentTopInset -
        (spacing.lg + insetBottom) -
        BOTTOM_STACK_H -
        NO_REC_CONTENT_H -
        POSTER_FIT_BUFFER;
    const byHeight = Math.floor(available / POSTER_ASPECT);
    return Math.max(POSTER_MIN_W, Math.min(POSTER_MAX_W, byHeight));
}
// Full-screen dim that fades in with the keyboard. With the keyboard up the
// controls rise into the top ~12% of the screen — above GRADIENT_START, i.e.
// over near-clear image — and no static ramp can serve both that and a
// visible backdrop at rest. This layer resolves it: inert at rest, near-solid
// while composing, restored on blur.
const KEYBOARD_SCRIM_MAX = 0.9;
// Cross-fade for the backdrop as it decodes (expo-image `transition`). The
// screen sits on plain surfaceAlt until then — NOT the glyph fallback — so
// the image never hard-swaps over a placeholder icon. See titleMeta.
const IMAGE_FADE_MS = 200;
// Confirmation beat: everything EXCEPT the stars fades back to this opacity
// rather than unmounting. Unmounting was the bug — the column is
// bottom-anchored, so removing content let the survivors drop down and the
// "★ N" popped somewhere other than where the stars had just been. Fading
// keeps every box exactly where it was.
const CONFIRM_DIM_OPACITY = 0.3;
const CONFIRM_DIM_MS = 150;
// Confirmation beat duration — how long the "row collapses, ★ N pops" plays
// after Done before onSubmit fires (and the parent closes the sheet). The
// collapse timing + pop spring below are scaled to fill this window so the
// beat reads clearly rather than flashing past.
const CONFIRM_BEAT_MS = 1000;
// Collapse of the stars row (scales/fades toward center). ~60% of the beat,
// so the row is gone with a beat of breathing room before onSubmit fires.
const CONFIRM_COLLAPSE_MS = 600;

// Catalogue metadata for the image zone + meta line, read from public.titles
// on open. `null` (the state's initial value) means STILL LOADING — the zone
// shows plain surfaceAlt with no glyph. A resolved object with a null
// backdropPath means "confirmed no backdrop / no catalogue row" and IS the
// glyph-fallback signal. Keeping those two cases distinct is what prevents a
// glyph→image hard swap.
interface TitleMeta {
    backdropPath: string | null;
    // Independent of backdropPath — a catalogue row can have one and not
    // the other, so the poster renders (or is omitted) on its own merits.
    posterPath: string | null;
    title: string | null;
    year: string | null;
}

// Half-scale (1-10) rating → display stars number, e.g. 7 -> "3.5", 10 -> "5".
function formatStarsLabel(rating: number): string {
    const stars = rating / 2;
    return Number.isInteger(stars) ? String(stars) : stars.toFixed(1);
}

// Build the rec-comment body: note text, a blank line if both are present, then
// the rating line "Gave it ★★★★" (½ appended for a half). Note-only when
// share-rating is off; rating-line-only when there's no note. Capped at the
// recommendation_comments 500-char limit, reserving room so the rating line is
// never truncated. ("Gave it", not "I gave it" — a note starting with "I"
// stacked above "I gave it" read as a repetitive double-I.)
function buildCommentBody(
    note: string,
    rating: number | null,
    shareRating: boolean,
): string {
    const ratingLine =
        rating !== null && shareRating ? `Gave it ${ratingGlyphs(rating)}` : '';
    if (!ratingLine) return note.slice(0, NOTE_MAX);
    if (!note) return ratingLine;
    const room = NOTE_MAX - ratingLine.length - 2; // 2 for the "\n\n" separator
    const notePart = note.length > room ? note.slice(0, room) : note;
    return `${notePart}\n\n${ratingLine}`;
}

type StarVariant = 'empty' | 'half' | 'full';

// Map a (1-based) star slot + the current 1-10 rating to its visual
// variant. Star N is full when rating >= N * 2, half when rating ==
// N * 2 - 1, otherwise empty. Null rating → all empty.
function getStarVariant(starIndex: number, rating: number | null): StarVariant {
    if (rating === null) return 'empty';
    if (rating >= starIndex * 2) return 'full';
    if (rating === starIndex * 2 - 1) return 'half';
    return 'empty';
}

// Map a row-relative X coordinate to a 1-10 rating. Each star occupies
// rowWidth/STAR_COUNT pixels; left half maps to (starIndex*2 - 1),
// right half to starIndex*2. Out-of-range coordinates clamp to the
// nearest endpoint — drag past the rightmost star pins to 10, drag
// before the first half pins to 1. (Deselect-to-null lives on the
// tap-toggle path; drag never produces 0.)
function valueFromRowX(localX: number, rowWidth: number): number {
    if (rowWidth <= 0) return 1;
    const halfWidth = rowWidth / HALF_COUNT;
    const idx = Math.floor(localX / halfWidth);
    return Math.max(1, Math.min(HALF_COUNT, idx + 1));
}

// The control column, extracted for ONE reason: it is the only part of this
// screen that reads safe-area insets, and it has to read them from the
// SafeAreaProvider nested INSIDE the Modal.
//
// A React Native Modal renders into its own native window (a
// UIViewController on iOS, a Dialog on Android) — outside the view the root
// SafeAreaProvider measures. React context still flows through the Modal, so
// a useSafeAreaInsets() call in the OUTER component silently returns the
// ROOT window's insets, which is why the old close button sat too high.
// Calling the hook here, under the nested provider, measures the modal's own
// window. This is the pattern react-native-safe-area-context documents for
// modals, and it only works because this component is a DESCENDANT of that
// provider — moving the hook alone would have changed nothing.
//
// Everything else (shared values, the keyboard subscription) is passed down
// so there's exactly one source for each and no duplicate subscriptions.
function ContentColumn({
    active,
    frozenPad,
    keyboardHeight,
    keyboardProgress,
    children,
}: {
    active: SharedValue<number>;
    frozenPad: SharedValue<number>;
    keyboardHeight: SharedValue<number>;
    keyboardProgress: SharedValue<number>;
    // Render prop, not plain children: the poster's size depends on the
    // real insets, which only this component can read (see above), so the
    // computed width has to flow DOWN from here rather than being worked
    // out by the caller against the wrong window.
    children: (posterWidth: number) => ReactNode;
}) {
    const insets = useSafeAreaInsets();
    const { height: windowHeight } = useWindowDimensions();
    // Top clearance: status bar + the close button's band. Only binds when
    // content OVERFLOWS (short content is bottom-anchored and never reaches
    // up here) — it's what stops a tall rec-fork layout scrolling under
    // either the status bar or the X.
    const contentTopInset =
        insets.top + spacing.base + CLOSE_BUTTON_SIZE;
    // Keyboard-driven bottom padding lifts the controls above the keyboard
    // (-keyboardHeight) plus a constant lg gap, minus the home-indicator
    // inset as the keyboard rises. While dismissing (active === 0) it holds
    // frozenPad so the fade-out has no reflow.
    const padStyle = useAnimatedStyle(() => {
        let paddingBottom;
        if (active.value === 1) {
            paddingBottom =
                -keyboardHeight.value +
                spacing.lg +
                insets.bottom * (1 - keyboardProgress.value);
            frozenPad.value = paddingBottom;
        } else {
            paddingBottom = frozenPad.value;
        }
        return { paddingBottom };
    });
    const posterWidth = posterWidthFor(
        windowHeight,
        contentTopInset,
        insets.bottom,
    );
    return (
        <Reanimated.View
            style={[
                styles.contentColumn,
                { paddingTop: contentTopInset },
                padStyle,
            ]}
        >
            {children(posterWidth)}
        </Reanimated.View>
    );
}

// Wraps a block that should recede — but NOT move — during the confirmation
// beat. Stays mounted at all times so its box keeps its size and position in
// the bottom-anchored column; only opacity changes, and pointerEvents goes
// inert so a dimmed control can't be tapped mid-beat.
function DimDuringConfirm({
    confirming,
    style,
    children,
}: {
    confirming: boolean;
    style?: StyleProp<ViewStyle>;
    children: ReactNode;
}) {
    return (
        <MotiView
            animate={{ opacity: confirming ? CONFIRM_DIM_OPACITY : 1 }}
            transition={{ type: 'timing', duration: CONFIRM_DIM_MS }}
            pointerEvents={confirming ? 'none' : 'auto'}
            style={style}
        >
            {children}
        </MotiView>
    );
}

// Top-left close. Its own component for the same reason as ContentColumn:
// it needs the MODAL's safe-area inset, which only a descendant of the
// nested SafeAreaProvider can read. Chip + size match the title page's
// close button so the chrome doesn't shift between the two screens.
//
// Semantics are CLOSE WITHOUT RATING, not cancel: by the time this screen
// is up, every call site has already committed status='watched' to the DB,
// so there is nothing here to undo (handleSkip's own write path is
// unchanged).
function CloseButton({
    confirming,
    onPress,
}: {
    confirming: boolean;
    onPress: () => void;
}) {
    const insets = useSafeAreaInsets();
    return (
        <DimDuringConfirm
            confirming={confirming}
            style={[
                styles.closeButtonWrap,
                { top: insets.top + spacing.base },
            ]}
        >
            <Pressable
                onPress={onPress}
                hitSlop={spacing.sm}
                accessibilityRole="button"
                accessibilityLabel="Close without rating"
                style={({ pressed }) => [
                    styles.closeButton,
                    {
                        backgroundColor: onImage.chip,
                        opacity: pressed ? 0.6 : 1,
                    },
                ]}
            >
                <X color={onImage.text} size={20} />
            </Pressable>
        </DimDuringConfirm>
    );
}

// NOTE: despite the file/export name, this is now a FULL-SCREEN rating
// SCREEN, not a bottom sheet — the title's backdrop fills the whole frame
// behind the controls. The name is kept because four screens mount it as
// `RatingSheet`; renaming is a mechanical follow-up, not a behaviour change.
//
// Star rating prompt shown after a Watched transition. Caller controls
// visible / busy / initialRating; the screen owns (a) the tentative
// selection the user is building toward Done and (b) the press-in fill
// preview that lights stars while the finger is down.
export function RatingSheet({
    visible,
    busy,
    initialRating,
    tmdbId,
    mediaType,
    onSubmit,
}: RatingSheetProps) {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    // NO useSafeAreaInsets() here, deliberately: this component sits OUTSIDE
    // the Modal, so the hook would report the ROOT window's insets, not the
    // modal's. Everything inset-dependent lives in ContentColumn, under the
    // SafeAreaProvider nested inside the Modal below.
    const router = useRouter();
    // Animated keyboard height (negative: 0 → -keyboardHeight) + progress (0
    // closed → 1 open) drive the panel's bottom padding so it docks above the
    // keyboard once the note field is focused — same scaffold as DeclineSheet.
    const { height: keyboardHeight, progress: keyboardProgress } =
        useReanimatedKeyboardAnimation();
    // Mounted only while opening/open (mounts when the fetch resolves, not on
    // `visible`); stays mounted through the close animation.
    const [mounted, setMounted] = useState(false);
    // 0 = closed (screen fully transparent), 1 = open. Starts closed — the
    // open effect drives it once the fetch settles. Drives the cross-fade.
    const progress = useSharedValue(0);
    // 1 while open/settling, 0 the instant dismissal starts — freezes the
    // keyboard-driven padding (frozenPad) so nothing reflows during the exit.
    const active = useSharedValue(0);
    // Seeded WITHOUT the bottom inset (which this component can't read
    // correctly — see above). It's a pre-first-frame fallback only: the
    // animated style overwrites it on the first frame where active === 1,
    // and it's never read before then because the Modal isn't mounted.
    // Explicit <number>: the spacing tokens are `as const`, so the seed
    // would otherwise narrow this to SharedValue<24>.
    const frozenPad = useSharedValue<number>(spacing.lg);
    // Tentative selection — committed only when Done is pressed.
    // Tapping the same half-star value a second time deselects it.
    const [selected, setSelected] = useState<number | null>(initialRating);
    // Press-in preview — lights stars while the user holds. Clears on
    // press-out so the display falls back to `selected`.
    const [pressedRating, setPressedRating] = useState<number | null>(null);
    // Measured row width — set via onLayout. Drives the X→value mapping.
    const [rowWidth, setRowWidth] = useState(0);
    // Confirmation beat: Done flips this true, the star row collapses and a
    // single "★ N" pops in, THEN onSubmit fires (delayed so the beat is
    // visible before the parent closes the sheet). Reset on each open.
    const [confirming, setConfirming] = useState(false);

    // Post-watched fork. `received` is null until the open-time lookup resolves;
    // [] = no-rec case, length > 0 = rec case. The note text, the per-sender
    // selection (all pre-selected), and the share-rating toggle are held here;
    // the submit writes land in a later step.
    const [received, setReceived] = useState<ReceivedRec[] | null>(null);
    const [currentUserId, setCurrentUserId] = useState<string | null>(null);
    const [selectedSenderIds, setSelectedSenderIds] = useState<Set<string>>(
        () => new Set(),
    );
    const [note, setNote] = useState('');
    const [shareRating, setShareRating] = useState(true);
    // Marks the item private (items.visibility = 'private'). Initialized from
    // the item's current visibility on open (default OFF for a 'friends' item);
    // ON collapses the whole rec framing — private includes the recommender.
    const [hiddenFromFriends, setHiddenFromFriends] = useState(false);
    // The item's visibility at open (private?) — the baseline for deciding
    // whether the privacy toggle actually changed anything on submit.
    const [initialPrivate, setInitialPrivate] = useState(false);
    // While the sheet's own writes (comment / note / visibility) are in flight.
    const [submitting, setSubmitting] = useState(false);
    // Image-zone + meta-line source. null = still loading (see TitleMeta).
    const [titleMeta, setTitleMeta] = useState<TitleMeta | null>(null);
    // True while the note field holds focus — i.e. the keyboard is up (the
    // note is the sheet's only input). Drives the compact keyboard layout:
    // the heading drops to headingDisplay/1 line, the meta line hides, and
    // the secondary group (visibility + recommend + review) collapses so the
    // note and the pinned actions stay reachable. Everything returns on blur.
    const [noteFocused, setNoteFocused] = useState(false);

    // Refs mirror state for the PanResponder closures: the responder is
    // created once via useRef, so its handlers can't close over the
    // latest state values.
    const rowRef = useRef<View>(null);
    const rowWidthRef = useRef(0);
    const rowPageXRef = useRef(0);
    const pressedRatingRef = useRef<number | null>(null);
    // Which value last triggered a haptic. Drag haptics fire once per
    // transition into a new half-star value rather than on every move
    // event.
    const lastHapticValueRef = useRef<number | null>(null);
    // Pending onSubmit timer for the confirmation beat; cleared on unmount.
    const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(
        () => () => {
            if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
        },
        [],
    );

    // Loop-completion facts from a completed submit, held until the sheet
    // has FULLY closed — the store-review prompt (an OS dialog) must never
    // appear over the dismissing sheet. Consumed by the effect on `mounted`
    // below; all decision logic (rating threshold, once-only, first-session)
    // lives in review.ts — this just reports what happened.
    const pendingReviewFactsRef = useRef<{
        rating: number;
        advancedRecCount: number;
    } | null>(null);

    // Snapshot initialRating at the open edge (visible false → true) so a later
    // change to the prop while the sheet is open can't re-seed it. An initial
    // value must stay initial: on the rec screen a realtime load() rewrites the
    // parent's currentRating (→ initialRating) mid-beat, and if the open effect
    // read the live prop it would re-run and reset the confirmation beat (sheet
    // almost closes, snaps back, then closes). Captured during render so it's set
    // before the open effect runs; re-captured on every open, so reopening after
    // a re-rate seeds fresh. The open effect reads THIS, never the live prop —
    // which is why initialRating is legitimately absent from its deps (the effect
    // no longer references it), not suppressed.
    const openSeedRatingRef = useRef<number | null>(initialRating);
    const wasVisibleRef = useRef(visible);
    if (visible && !wasVisibleRef.current) {
        openSeedRatingRef.current = initialRating;
    }
    wasVisibleRef.current = visible;

    useEffect(() => {
        rowWidthRef.current = rowWidth;
    }, [rowWidth]);
    useEffect(() => {
        pressedRatingRef.current = pressedRating;
    }, [pressedRating]);

    // Guards triggerOpen so the fetch's finally + the max-wait timer can't both
    // open (only the first wins).
    const openedRef = useRef(false);

    // Fetch-before-open orchestration. On `visible`: reset for this open, run
    // the received-recs + visibility lookup, THEN slide up — so the sheet opens
    // already knowing rec vs no-rec, at its true final height (no content settle
    // after the slide). A max wait (OPEN_MAX_WAIT_MS) caps a slow fetch; past it
    // the sheet opens in the no-rec layout and the rec section appears when the
    // fetch lands (rare). Failure / missing title / session → no-rec case.
    useEffect(() => {
        if (!visible) return;

        // Reset internal state for this open.
        setSelected(openSeedRatingRef.current);
        setPressedRating(null);
        setConfirming(false);
        setReceived(null);
        setCurrentUserId(null);
        setSelectedSenderIds(new Set());
        setNote('');
        setShareRating(true);
        setHiddenFromFriends(false);
        setInitialPrivate(false);
        setSubmitting(false);
        setTitleMeta(null);
        setNoteFocused(false);
        lastHapticValueRef.current = null;
        openedRef.current = false;

        let cancelled = false;
        const open = () => {
            if (cancelled || openedRef.current) return;
            openedRef.current = true;
            setMounted(true);
            active.value = 1;
            progress.value = withTiming(1, {
                duration: OPEN_MS,
                easing: Easing.out(Easing.cubic),
            });
        };
        const timer = setTimeout(open, OPEN_MAX_WAIT_MS);

        // Resolves the image zone out of its loading state. Any path that
        // can't produce a backdrop lands here with nulls, which is the
        // glyph-fallback signal (distinct from the null STATE = loading).
        const resolveTitleMeta = (meta: TitleMeta) => {
            if (!cancelled) setTitleMeta(meta);
        };
        const NO_TITLE: TitleMeta = {
            backdropPath: null,
            posterPath: null,
            title: null,
            year: null,
        };

        (async () => {
            try {
                if (tmdbId === null || mediaType === null) {
                    if (!cancelled) setReceived([]);
                    resolveTitleMeta(NO_TITLE);
                    return;
                }
                const {
                    data: { session },
                } = await supabase.auth.getSession();
                const uid = session?.user.id ?? null;
                if (!uid) {
                    if (!cancelled) setReceived([]);
                    resolveTitleMeta(NO_TITLE);
                    return;
                }
                const [recs, itemRow, titleByKey] = await Promise.all([
                    getReceivedRecsForTitle(uid, tmdbId, mediaType),
                    supabase
                        .from('items')
                        .select('visibility')
                        .eq('user_id', uid)
                        .eq('tmdb_id', tmdbId)
                        .eq('media_type', mediaType)
                        .maybeSingle(),
                    // Catalogue read for the image zone + meta line. `.catch`
                    // isolates it: a titles failure must not reject the whole
                    // Promise.all and take the rec fork down with it — the
                    // sheet's job is rating, the image is decoration.
                    fetchTitlesByItems([
                        { tmdb_id: tmdbId, media_type: mediaType },
                    ]).catch(() => null),
                ]);
                if (cancelled) return;
                const isPrivate = itemRow.data?.visibility === 'private';
                setCurrentUserId(uid);
                setReceived(recs);
                setSelectedSenderIds(new Set(recs.map((r) => r.fromUserId)));
                setInitialPrivate(isPrivate);
                setHiddenFromFriends(isPrivate);
                const row =
                    titleByKey?.get(`${mediaType}:${tmdbId}`) ?? null;
                resolveTitleMeta({
                    backdropPath: row?.backdrop_path ?? null,
                    posterPath: row?.poster_path ?? null,
                    title: row?.title ?? null,
                    year: row?.release_date
                        ? row.release_date.slice(0, 4)
                        : null,
                });
            } catch (err) {
                console.warn('rating sheet: received recs fetch failed', err);
                if (!cancelled) setReceived([]);
                resolveTitleMeta(NO_TITLE);
            } finally {
                // Content now known — open (or the timer already did).
                clearTimeout(timer);
                open();
            }
        })();

        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [visible, tmdbId, mediaType, active, progress]);

    // Close: slide down + unmount when `visible` goes false (only if actually
    // open — a dismiss before the fetch resolved just cancels the open above).
    useEffect(() => {
        if (visible || !mounted) return;
        // Freeze layout inputs before the exit slide so nothing reflows.
        active.value = 0;
        progress.value = withTiming(
            0,
            { duration: CLOSE_MS, easing: Easing.in(Easing.cubic) },
            (finished) => {
                if (finished) runOnJS(setMounted)(false);
            },
        );
    }, [visible, mounted, active, progress]);

    // Store-review prompt, AFTER the sheet has fully closed. `mounted` flips
    // false via runOnJS exactly when the close animation finishes (the timing
    // callback above), so this is animation-completion-derived — no timers —
    // and the OS dialog can never appear over the dismissing sheet. Fires at
    // most once per banked submit (the ref is consumed); review.ts self-limits
    // to once ever.
    useEffect(() => {
        if (mounted) return;
        const facts = pendingReviewFactsRef.current;
        if (!facts) return;
        pendingReviewFactsRef.current = null;
        void maybeRequestReviewAfterRecRating(facts);
    }, [mounted]);

    // The whole screen cross-fades — this IS the entrance and the exit.
    // No translateY: opened from the title page, whose hero is this same
    // backdrop, a dissolve reads as that hero becoming the rating screen.
    const rootFadeStyle = useAnimatedStyle(() => ({
        opacity: progress.value,
    }));
    // The control column's keyboard-aware padding moved into ContentColumn
    // (it needs the modal's own bottom inset) — see that component.
    // Keyboard scrim — see KEYBOARD_SCRIM_MAX. Rides the same
    // keyboardProgress everything else keyboard-driven reads, so it arrives
    // exactly as the controls rise into the clear top of the frame.
    const keyboardScrimStyle = useAnimatedStyle(() => ({
        opacity: interpolate(
            keyboardProgress.value,
            [0, 1],
            [0, KEYBOARD_SCRIM_MAX],
        ),
    }));

    // Captures both the row's width and its absolute page-X position
    // (via measure()). pageX is required to translate the gesture's
    // moveX (screen coords) into row-relative coordinates — onLayout
    // alone only gives parent-relative offsets.
    function handleRowLayout() {
        rowRef.current?.measure((_x, _y, w, _h, pageX) => {
            setRowWidth(w);
            rowPageXRef.current = pageX;
        });
    }

    // Row-level drag gesture. Quick taps still go through the per-half
    // Pressables (onStartShouldSet returns false); only crossing the
    // DRAG_THRESHOLD_PX claims the responder for drag-to-rate.
    //
    // Axis dominance (|dx| > |dy|) is REQUIRED, not cosmetic: the control
    // zone is a ScrollView now, and the old "either axis past the threshold"
    // test meant a vertical swipe that happened to start on the stars set a
    // rating instead of scrolling the sheet. Claiming only on a
    // horizontally-dominant drag leaves vertical gestures to the ScrollView.
    const panResponder = useRef(
        PanResponder.create({
            onStartShouldSetPanResponder: () => false,
            onMoveShouldSetPanResponder: (_, g) =>
                Math.abs(g.dx) > Math.abs(g.dy) &&
                Math.abs(g.dx) > DRAG_THRESHOLD_PX,
            onPanResponderGrant: (_, g) => {
                const localX = g.x0 - rowPageXRef.current;
                const value = valueFromRowX(localX, rowWidthRef.current);
                setPressedRating(value);
                if (lastHapticValueRef.current !== value) {
                    lastHapticValueRef.current = value;
                    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                }
            },
            onPanResponderMove: (_, g) => {
                const localX = g.moveX - rowPageXRef.current;
                const value = valueFromRowX(localX, rowWidthRef.current);
                setPressedRating(value);
                if (lastHapticValueRef.current !== value) {
                    lastHapticValueRef.current = value;
                    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                }
            },
            onPanResponderRelease: () => {
                const committed = pressedRatingRef.current;
                setPressedRating(null);
                lastHapticValueRef.current = null;
                if (committed !== null) setSelected(committed);
            },
            onPanResponderTerminate: () => {
                setPressedRating(null);
                lastHapticValueRef.current = null;
            },
        }),
    ).current;

    function handleHalfPressIn(value: number) {
        setPressedRating(value);
        // Share the haptic-tracker with the PanResponder so its
        // onPanResponderGrant doesn't re-fire a haptic for this value.
        lastHapticValueRef.current = value;
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }

    function handleHalfPress(value: number) {
        // Tap-toggle: same value a second time clears the selection.
        setSelected((curr) => (curr === value ? null : value));
    }

    async function handleSubmit() {
        // Re-entrancy / nothing-to-commit guards.
        if (busy || submitting || confirming) return;
        if (!hasSomethingToCommit) return;

        const body = note.trim();
        const uid = currentUserId;

        // The sheet's own writes (privacy, comment, note) — each independent so
        // one failure can't lose another, and none of them can lose the rating
        // (which fires below via onSubmit regardless). Only possible with a
        // known user + title.
        if (uid !== null && tmdbId !== null && mediaType !== null) {
            setSubmitting(true);

            // 1. Privacy — reuse setItemVisibility, exactly as the title page.
            if (visibilityChanged) {
                try {
                    await setItemVisibility({
                        userId: uid,
                        tmdbId,
                        mediaType,
                        visibility: hiddenFromFriends ? 'private' : 'friends',
                    });
                } catch (err) {
                    console.error('rating sheet: visibility update failed', err);
                    Alert.alert('Could not update privacy', 'Please try again.');
                }
            }

            // 2a. Rec case: post the note (+ optional rating glyphs) to each
            //     selected sender's rec. Collect the rec ids whose comment
            //     actually landed — those senders are suppressed below (they get
            //     the comment, not also a rec_watched ping).
            const suppressRecIds = new Set<string>();
            if (recFork && willSend) {
                const commentBody = buildCommentBody(body, selected, shareRating);
                if (commentBody.length > 0) {
                    const targets = recs.filter((r) =>
                        selectedSenderIds.has(r.fromUserId),
                    );
                    const results = await Promise.allSettled(
                        targets.map((r) =>
                            postRecComment(r.recId, uid, commentBody, true),
                        ),
                    );
                    results.forEach((res, i) => {
                        if (res.status === 'fulfilled') {
                            suppressRecIds.add(targets[i].recId);
                        }
                    });
                    if (results.some((r) => r.status === 'rejected')) {
                        console.error('rating sheet: comment post failed', results);
                        Alert.alert(
                            "Couldn't send",
                            "Your comment didn't send. Your rating was still saved.",
                        );
                    }
                }
            }
            // No no-rec branch: the old 2b wrote the note to items.note, which
            // rides a friends-visible items row (RLS is row-level, not column-
            // level), so "Just for you" was never private — and nothing ever
            // read it back. items.note is now unwritten (column left dormant).
            // Outside the rec fork there is now no target for a note.

            // 3. Rating write + rec → watched transitions, LAST (after privacy
            //    committed and comments posted, so the suppress set is known and
            //    the trigger sees the visibility). Independent of the writes
            //    above.
            try {
                const { advancedRecCount } = await applyWatchedRating({
                    userId: uid,
                    tmdbId,
                    mediaType,
                    rating: selected,
                    suppressRecIds,
                });
                // Bank the loop-completion facts for the store-review prompt;
                // fired only after the sheet has fully closed (see the effect
                // on `mounted`). review.ts owns the thresholds and guards.
                if (selected !== null) {
                    pendingReviewFactsRef.current = {
                        rating: selected,
                        advancedRecCount,
                    };
                }
            } catch (err) {
                console.error('rating sheet: mark watched failed', err);
                Alert.alert("Couldn't finish", 'Please try again.');
            }

            setSubmitting(false);
        }

        // 3. Rating — via onSubmit, exactly as RatingSheet does today. Play the
        //    confirmation beat only when a rating was chosen; otherwise submit
        //    null (no rating) and let the parent close. Independent of the
        //    writes above — a comment/note failure can't lose the rating.
        if (selected !== null) {
            setConfirming(true);
            confirmTimerRef.current = setTimeout(() => {
                onSubmit(selected);
            }, CONFIRM_BEAT_MS);
        } else {
            onSubmit(null);
        }
    }

    function handleSkip() {
        // Skip / dismiss still marks the rec watched and notifies the sender
        // (plain rec_watched, empty suppress set) — the watch is real; only the
        // rating / note / comment are optional. Fire-and-forget so dismissal
        // stays instant; currentUserId may be unset if dismissed before the
        // open-time fetch resolved, so fall back to the session.
        if (tmdbId !== null && mediaType !== null) {
            const tid = tmdbId;
            const mt = mediaType;
            void (async () => {
                try {
                    const uid =
                        currentUserId ??
                        (await supabase.auth.getSession()).data.session?.user
                            .id ??
                        null;
                    if (uid !== null) {
                        await applyWatchedRating({
                            userId: uid,
                            tmdbId: tid,
                            mediaType: mt,
                            rating: null,
                        });
                    }
                } catch (err) {
                    console.error(
                        'rating sheet: mark watched (skip) failed',
                        err,
                    );
                }
            })();
        }
        onSubmit(null);
    }

    // Rec-case fork. received === null → still loading (shown as no-rec until
    // it resolves); length > 0 → rec case.
    const recs = received ?? [];
    const isRecCase = recs.length > 0;
    const firstNameOf = (name: string) => name.split(/\s+/)[0];
    // Name for the header / share-rating toggle: the single sender's first
    // name, or "them" when there are several.
    const recipientLabel =
        recs.length === 1 ? firstNameOf(recs[0].sender.displayName) : 'them';
    // The rec framing (header / chips / share-rating toggle / Send) shows only
    // when it's a rec case AND not marked private — a private note isn't shared
    // with the recommender either.
    const recFork = isRecCase && !hiddenFromFriends;
    const headerText = recFork
        ? `Tell ${recipientLabel} what you thought`
        : 'What did you think?';
    // The title is its own headline in the identity group now, so the meta
    // line below it is just "2024 · Film". Parts drop out cleanly when the
    // catalogue row is thin (no release date), so a sparse row degrades to
    // "Film" rather than leaving a stray separator.
    const titleText = titleMeta?.title ?? null;
    const metaLine = [
        titleMeta?.year ?? null,
        mediaType === 'tv' ? 'TV' : mediaType === 'movie' ? 'Film' : null,
    ]
        .filter(Boolean)
        .join(' · ');
    // Backdrop resolved and present → image. Resolved and absent → glyph.
    // Still loading (titleMeta === null) → neither; plain surfaceAlt.
    const backdropPath = titleMeta?.backdropPath ?? null;
    const titleMetaResolved = titleMeta !== null;
    // Null → the poster is omitted and the identity group closes up around
    // it. The whole group (poster included) is hidden in the compact
    // note-focused state — it's the biggest single thing we can reclaim to
    // keep Send above the keyboard.
    const posterPath = titleMeta?.posterPath ?? null;
    // Chips only when there's more than one sender to pick between.
    const showChips = recFork && recs.length > 1;
    // A comment has content when there's a note, or a rating being shared.
    const commentHasContent =
        note.trim().length > 0 || (selected !== null && shareRating);
    // Primary action is "Send" only when a comment will actually go out.
    const willSend =
        recFork && selectedSenderIds.size > 0 && commentHasContent;
    // Did the privacy toggle change the item's stored visibility?
    const visibilityChanged = hiddenFromFriends !== initialPrivate;
    // Quiet footer links — see the JSX comment above their render for the
    // full rationale (persistent conditional links, not popups).
    const canWriteReview = tmdbId !== null && mediaType !== null;
    // 8+ on the 1-10 half-star scale = 8 (4★) and up. Matches
    // SUGGEST_MIN_RATING (library/add.tsx) — the same "recommend-worthy"
    // bar the app already uses for library recommend suggestions, not a
    // new number.
    const canRecommend = canWriteReview && selected !== null && selected >= 8;
    function toggleSender(id: string) {
        setSelectedSenderIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }

    // Stars fill from the pressed preview first; when not pressing,
    // fall back to the committed selection.
    const effectiveRating = pressedRating ?? selected;
    // Rating is optional: the primary enables when there's ANYTHING to commit —
    // a rating, a non-empty note, or a privacy change. All-empty → close.
    // The note only counts when it can actually be written — i.e. in the rec
    // fork (2a). Outside it the field is hidden and there's no target, so a
    // leftover note (typed, then privacy toggled ON) must not keep the button
    // enabled or it would submit and silently drop the text. Note state is kept
    // (not cleared) so toggling privacy back off restores it in the field.
    const hasSomethingToCommit =
        selected !== null ||
        (recFork && note.trim().length > 0) ||
        visibilityChanged;
    const primaryDisabled = busy || submitting || !hasSomethingToCommit;

    return (
        <Modal
            visible={mounted}
            transparent
            animationType="none"
            // Full-screen now: on Android the modal must draw under the
            // status bar or the image stops short of it and the top strip
            // reads as a band again.
            statusBarTranslucent
            onRequestClose={handleSkip}
        >
            {/* Nested provider — measures THIS modal's window rather than
                the app root's, so ContentColumn's insets are the real ones.
                Seeded with initialWindowMetrics so the first frame has
                sensible values instead of zeros (which would show as a
                one-frame jump in the top padding) before measurement lands. */}
            <SafeAreaProvider initialMetrics={initialWindowMetrics}>
            {/* Root — the whole screen, cross-fading on `progress`. Base
                colour is the ground so the dissolve lands on solid navy
                rather than showing the page beneath through a half-drawn
                image. No dismiss-on-tap layer: the top-left X and hardware
                back are the exits (both handleSkip). */}
            <Reanimated.View
                style={[
                    StyleSheet.absoluteFill,
                    { backgroundColor: palette.bg },
                    rootFadeStyle,
                ]}
            >
                {/* LAYER 1 — the backdrop, full screen. Three states, and
                    the loading/absent split is what avoids a glyph→image
                    hard swap: present → cross-fades in over bare
                    surfaceAlt; resolved-but-absent → FilmStrip; still
                    loading → neither. The glyph sits high in the frame
                    (not screen-centred) so it lands where the image reads
                    rather than under the gradient's solid half. */}
                {backdropPath ? (
                    <Image
                        source={{ uri: imageUrl(backdropPath, 'w780') }}
                        style={StyleSheet.absoluteFillObject}
                        contentFit="cover"
                        blurRadius={BACKDROP_BLUR}
                        transition={IMAGE_FADE_MS}
                    />
                ) : (
                    <View
                        style={[
                            StyleSheet.absoluteFillObject,
                            { backgroundColor: palette.surfaceAlt },
                        ]}
                    >
                        {titleMetaResolved ? (
                            <View style={styles.imageFallback}>
                                <FilmStrip
                                    color={palette.textMuted}
                                    size={48}
                                />
                            </View>
                        ) : null}
                    </View>
                )}
                {/* LAYER 1b — flat dim over the whole image (IMAGE_DIM), so
                    even the clear top of the frame is knocked back and the
                    close X always has something to sit on. */}
                <View
                    pointerEvents="none"
                    style={[
                        StyleSheet.absoluteFillObject,
                        {
                            backgroundColor: palette.bg,
                            opacity: IMAGE_DIM,
                        },
                    ]}
                />
                {/* LAYER 2 — the vertical ramp. PURE-ALPHA pair
                    (bgTransparent → bg); a 'transparent' → bg ramp greys
                    the midpoint. Clear above GRADIENT_START, solid below
                    GRADIENT_SOLID — see those constants. */}
                <LinearGradient
                    colors={[
                        palette.bgTransparent,
                        palette.bg,
                        palette.bg,
                    ]}
                    locations={[GRADIENT_START, GRADIENT_SOLID, 1]}
                    style={StyleSheet.absoluteFillObject}
                    pointerEvents="none"
                />
                {/* LAYER 3 — keyboard scrim. Inert at rest. */}
                <Reanimated.View
                    pointerEvents="none"
                    style={[
                        StyleSheet.absoluteFillObject,
                        { backgroundColor: palette.bg },
                        keyboardScrimStyle,
                    ]}
                />

                    {/* LAYER 4 — CONTROL COLUMN. Bottom-anchored
                        (justifyContent flex-end) so short content sits low
                        over the solid part of the ramp and tall content
                        grows upward. paddingTop keeps an overflowing layout
                        clear of the status bar; the ScrollView absorbs the
                        overflow while the actions below stay pinned. */}
                    <ContentColumn
                        active={active}
                        frozenPad={frozenPad}
                        keyboardHeight={keyboardHeight}
                        keyboardProgress={keyboardProgress}
                    >
                    {(posterWidth) => (
                    <>
                    <ScrollView
                        style={styles.scroll}
                        contentContainerStyle={styles.scrollContent}
                        keyboardShouldPersistTaps="handled"
                        showsVerticalScrollIndicator={false}
                    >
                    {/* IDENTITY GROUP — what is being rated: the sharp
                        poster, the title directly under it, then year ·
                        type. Hidden WHOLESALE in the compact note-focused
                        state (gating the group, not each child, so no stray
                        lg gap is left behind). The title is no longer part
                        of the meta line — it's the group's own headline. */}
                    {!noteFocused ? (
                        <DimDuringConfirm
                            confirming={confirming}
                            style={styles.identityGroup}
                        >
                            {posterPath ? (
                                <Image
                                    source={{
                                        uri: imageUrl(posterPath, 'w342'),
                                    }}
                                    style={[
                                        styles.poster,
                                        {
                                            width: posterWidth,
                                            height: Math.round(
                                                posterWidth * POSTER_ASPECT,
                                            ),
                                        },
                                    ]}
                                    contentFit="cover"
                                    transition={IMAGE_FADE_MS}
                                />
                            ) : null}
                            <View style={styles.titleBlock}>
                                {titleText ? (
                                    <Text
                                        numberOfLines={2}
                                        style={[
                                            typography.headingDisplay,
                                            styles.centredText,
                                            { color: palette.text },
                                        ]}
                                    >
                                        {titleText}
                                    </Text>
                                ) : null}
                                {metaLine.length > 0 ? (
                                    <Text
                                        numberOfLines={1}
                                        style={[
                                            typography.caption,
                                            styles.centredText,
                                            { color: palette.textMuted },
                                        ]}
                                    >
                                        {metaLine}
                                    </Text>
                                ) : null}
                            </View>
                        </DimDuringConfirm>
                    ) : null}
                    {/* ACTION GROUP — the question, the stars it's asking
                        about, and the privacy row, as one tight unit. The
                        question sits a size ABOVE the title but in the body
                        semibold face, so identity and instruction read as
                        different kinds of thing rather than competing
                        headlines. The received-recs lookup runs before the
                        open fade, so headerText is already correct here; no
                        fade gate. */}
                    <View style={styles.actionGroup}>
                    <DimDuringConfirm
                        confirming={confirming}
                        style={styles.questionWrap}
                    >
                    <Text
                        numberOfLines={noteFocused ? 1 : 2}
                        style={[
                            styles.question,
                            styles.centredText,
                            { color: palette.text },
                        ]}
                    >
                        {headerText}
                    </Text>
                    </DimDuringConfirm>
                    <View style={styles.ratingArea}>
                    <MotiView
                        // Collapses toward center as the confirmation beat
                        // plays; scale 1 / opacity 1 normally so it's inert.
                        animate={{
                            scale: confirming ? 0.2 : 1,
                            opacity: confirming ? 0 : 1,
                        }}
                        transition={{
                            type: 'timing',
                            duration: CONFIRM_COLLAPSE_MS,
                        }}
                        pointerEvents={confirming ? 'none' : 'auto'}
                    >
                    <View
                        ref={rowRef}
                        onLayout={handleRowLayout}
                        style={styles.starsRow}
                        {...panResponder.panHandlers}
                    >
                        {[1, 2, 3, 4, 5].map((starIndex) => {
                            const variant = getStarVariant(starIndex, effectiveRating);
                            const leftValue = starIndex * 2 - 1;
                            const rightValue = starIndex * 2;
                            const iconColor =
                                variant === 'empty'
                                    ? palette.textMuted
                                    : palette.accent;
                            return (
                                <MotiView
                                    key={starIndex}
                                    // Staggered entrance — each star scales/
                                    // fades in slightly after the previous as
                                    // the sheet opens (plays once on mount).
                                    from={{ opacity: 0, scale: 0.5 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    transition={{
                                        type: 'spring',
                                        damping: 14,
                                        stiffness: 200,
                                        delay: starIndex * 55,
                                    }}
                                    style={styles.starCell}
                                >
                                    {/* The visual layer renders behind the
                                        tap overlays; pointerEvents:none on
                                        the style so finger events fall
                                        through to the Pressable halves. */}
                                    <View style={styles.starVisual}>
                                        {variant === 'full' ? (
                                            <Star
                                                color={iconColor}
                                                weight="fill"
                                                size={36}
                                            />
                                        ) : variant === 'half' ? (
                                            // StarHalf fills the left side
                                            // only; the right side is
                                            // outlined by an underlying
                                            // empty Star at the same
                                            // position to keep the full
                                            // star silhouette intact.
                                            <View style={styles.starStack}>
                                                <Star
                                                    color={palette.textMuted}
                                                    size={36}
                                                />
                                                <View style={styles.halfOverlay}>
                                                    <StarHalf
                                                        color={palette.accent}
                                                        weight="fill"
                                                        size={36}
                                                    />
                                                </View>
                                            </View>
                                        ) : (
                                            <Star
                                                color={palette.textMuted}
                                                size={36}
                                            />
                                        )}
                                    </View>
                                    {/* Two tap zones overlaid on each
                                        star — left half writes the odd
                                        ½-star value, right half writes
                                        the even whole-star value. */}
                                    <Pressable
                                        onPressIn={() =>
                                            handleHalfPressIn(leftValue)
                                        }
                                        onPressOut={() => setPressedRating(null)}
                                        onPress={() => handleHalfPress(leftValue)}
                                        disabled={busy}
                                        style={({ pressed }) => [
                                            styles.halfHit,
                                            styles.halfLeft,
                                            { opacity: pressed || busy ? 0.6 : 1 },
                                        ]}
                                    />
                                    <Pressable
                                        onPressIn={() =>
                                            handleHalfPressIn(rightValue)
                                        }
                                        onPressOut={() => setPressedRating(null)}
                                        onPress={() => handleHalfPress(rightValue)}
                                        disabled={busy}
                                        style={({ pressed }) => [
                                            styles.halfHit,
                                            styles.halfRight,
                                            { opacity: pressed || busy ? 0.6 : 1 },
                                        ]}
                                    />
                                </MotiView>
                            );
                        })}
                    </View>
                    </MotiView>
                    {/* Confirmation beat — the chosen rating as a single
                        "★ N" that springs up where the collapsing row was. */}
                    {confirming && selected !== null ? (
                        <MotiView
                            from={{ scale: 0.4, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            transition={{
                                // Softened (lower stiffness/damping, same ratio)
                                // so the "★ N" springs up over a longer, legible
                                // arc that fills the longer beat instead of
                                // snapping in early and then sitting idle.
                                type: 'spring',
                                damping: 8,
                                stiffness: 90,
                            }}
                            pointerEvents="none"
                            style={styles.confirmOverlay}
                        >
                            <Star
                                color={palette.accent}
                                weight="fill"
                                size={40}
                            />
                            <Text
                                style={[
                                    typography.heading,
                                    { color: palette.text },
                                ]}
                            >
                                {formatStarsLabel(selected)}
                            </Text>
                        </MotiView>
                    ) : null}
                    </View>
                    {/* "Loved it? Send it to a friend" — appears once the
                        rating reaches 4 stars (selected >= 8, the same
                        SUGGEST_MIN_RATING bar library/add.tsx uses). It is
                        ALWAYS rendered while not note-focused and only
                        fades: dragging the stars across the threshold must
                        not move the visibility row or anything below it, so
                        the line's height stays reserved at every rating.
                        Routes to the same recommend screen the outlined
                        button used to. */}
                    {!noteFocused ? (
                        <DimDuringConfirm confirming={confirming}>
                            <MotiView
                                animate={{ opacity: canRecommend ? 1 : 0 }}
                                transition={{
                                    type: 'timing',
                                    duration: RECOMMEND_FADE_MS,
                                }}
                                pointerEvents={
                                    canRecommend ? 'auto' : 'none'
                                }
                            >
                                <Pressable
                                    onPress={() =>
                                        router.push(
                                            `/title/${mediaType}/${tmdbId}/recommend`,
                                        )
                                    }
                                    disabled={busy || !canRecommend}
                                    hitSlop={spacing.sm}
                                    accessibilityRole="button"
                                    accessibilityLabel="Send it to a friend"
                                    style={({ pressed }) => [
                                        styles.recommendLine,
                                        { opacity: pressed ? 0.6 : 1 },
                                    ]}
                                >
                                    <PaperPlaneTilt
                                        color={palette.accent}
                                        size={16}
                                    />
                                    <Text
                                        numberOfLines={1}
                                        style={[
                                            typography.body,
                                            { color: palette.accent },
                                        ]}
                                    >
                                        Loved it? Send it to a friend
                                    </Text>
                                </Pressable>
                            </MotiView>
                        </DimDuringConfirm>
                    ) : null}
                    {/* Privacy — a quiet caption-sized row directly under
                        the stars, centred with the rest of the column. NOT
                        hidden in the compact note-focused state: it's one
                        line and it's relevant to what's being written.
                        Unified polarity app-wide: ON = shared, OFF =
                        private — same phrasing + switch direction as the
                        title page's row. The internal state
                        (hiddenFromFriends) and the write path are
                        unchanged; only the presentation moved. */}
                    <DimDuringConfirm
                        confirming={confirming}
                        style={styles.visibilityRow}
                    >
                            <Text
                                style={[
                                    typography.caption,
                                    { color: palette.textMuted },
                                ]}
                            >
                                Visible to friends
                            </Text>
                            <Toggle
                                value={!hiddenFromFriends}
                                onValueChange={(v) =>
                                    setHiddenFromFriends(!v)
                                }
                                palette={palette}
                                disabled={busy}
                            />
                    </DimDuringConfirm>
                    </View>
                    {/* REC-FORK GROUP — who the note goes to, whether the
                        rating rides along, and the note itself. One group:
                        tight md rhythm inside, lg gap to its neighbours.
                        Content is known before the open slide, so recFork is
                        correct here — no fade gate. Sits BELOW the stars now
                        (the chips used to lead the sheet above them), so the
                        rating stays the hero control. */}
                    {recFork ? (
                        <DimDuringConfirm
                            confirming={confirming}
                            style={styles.recGroup}
                        >
                            {/* Multiple senders: recipient chips, all
                                pre-selected, tap to toggle who the note
                                goes to. */}
                            {showChips ? (
                                <View style={styles.chipsRow}>
                                    {recs.map((r) => {
                                        const on = selectedSenderIds.has(
                                            r.fromUserId,
                                        );
                                        return (
                                            <Pressable
                                                key={r.fromUserId}
                                                onPress={() =>
                                                    toggleSender(r.fromUserId)
                                                }
                                                disabled={busy}
                                                accessibilityRole="button"
                                                accessibilityState={{
                                                    selected: on,
                                                }}
                                                style={[
                                                    styles.chip,
                                                    {
                                                        borderColor: on
                                                            ? palette.accent
                                                            : palette.border,
                                                        backgroundColor: on
                                                            ? palette.accentWash
                                                            : 'transparent',
                                                        opacity: busy ? 0.6 : 1,
                                                    },
                                                ]}
                                            >
                                                <Avatar
                                                    avatarUrl={
                                                        r.sender.avatarUrl
                                                    }
                                                    displayName={
                                                        r.sender.displayName
                                                    }
                                                    seedId={r.fromUserId}
                                                    size={20}
                                                />
                                                <Text
                                                    style={[
                                                        typography.caption,
                                                        {
                                                            color: on
                                                                ? palette.accent
                                                                : palette.textMuted,
                                                        },
                                                    ]}
                                                >
                                                    {firstNameOf(
                                                        r.sender.displayName,
                                                    )}
                                                </Text>
                                            </Pressable>
                                        );
                                    })}
                                </View>
                            ) : null}
                            {/* Append the rating to the comment when ON.
                                Default ON. Collapses with the whole rec
                                framing when Visible-to-friends is OFF. */}
                            <View style={styles.toggleRow}>
                                <Text
                                    style={[
                                        typography.body,
                                        { color: palette.text },
                                    ]}
                                >
                                    Share rating with {recipientLabel}
                                </Text>
                                <Toggle
                                    value={shareRating}
                                    onValueChange={setShareRating}
                                    palette={palette}
                                    disabled={busy}
                                />
                            </View>
                            {/* Note only in the rec fork — it posts to the
                                sender's rec (2a). Outside it (no-rec, or a
                                private rec) there's no target, so no field.
                                Focus drives the compact keyboard layout. */}
                            <TextInput
                                value={note}
                                onChangeText={(v) =>
                                    setNote(v.slice(0, NOTE_MAX))
                                }
                                onFocus={() => setNoteFocused(true)}
                                onBlur={() => setNoteFocused(false)}
                                editable={!busy}
                                multiline
                                maxLength={NOTE_MAX}
                                placeholder="Add a note"
                                placeholderTextColor={palette.textMuted}
                                style={[
                                    styles.noteInput,
                                    typography.body,
                                    {
                                        color: palette.text,
                                        backgroundColor: palette.surface,
                                    },
                                ]}
                            />
                        </DimDuringConfirm>
                    ) : null}
                    </ScrollView>
                    {/* PINNED ACTIONS — outside the ScrollView so the primary
                        stays on screen at any content height, font scale, or
                        keyboard state. The rec-fork-with-keyboard case does
                        scroll on a small phone, and Send must never be the
                        thing you have to scroll to find. Recedes (never
                        unmounts) during the confirmation beat — see
                        DimDuringConfirm; handleSubmit's own re-entrancy guard
                        already ignores taps while confirming, and
                        pointerEvents makes that visible as well as true. */}
                    <DimDuringConfirm
                        confirming={confirming}
                        style={styles.actions}
                    >
                            {/* Write a review — a plain centred accent
                                text link, the quieter sibling of Done.
                                Recommend is no longer here: it moved under
                                the stars, where it can key off the rating.
                                Hides in the compact note-focused state —
                                reclaiming it keeps Send above the keyboard. */}
                            {!noteFocused && canWriteReview ? (
                                <Pressable
                                    onPress={() =>
                                        router.push(
                                            `/title/${mediaType}/${tmdbId}/review`,
                                        )
                                    }
                                    disabled={busy}
                                    hitSlop={spacing.sm}
                                    accessibilityRole="button"
                                    accessibilityLabel="Write a review"
                                    style={({ pressed }) => [
                                        styles.reviewLink,
                                        { opacity: pressed || busy ? 0.6 : 1 },
                                    ]}
                                >
                                    <Text
                                        style={[
                                            typography.body,
                                            { color: palette.accent },
                                        ]}
                                    >
                                        Write a review
                                    </Text>
                                </Pressable>
                            ) : null}
                            <Pressable
                                onPress={handleSubmit}
                                disabled={primaryDisabled}
                                style={({ pressed }) => [
                                    styles.doneButton,
                                    {
                                        backgroundColor: palette.accent,
                                        opacity: primaryDisabled
                                            ? 0.4
                                            : pressed
                                              ? 0.6
                                              : 1,
                                    },
                                ]}
                            >
                                <Text
                                    style={[
                                        typography.bodyEmphasis,
                                        { color: palette.textInverse },
                                    ]}
                                >
                                    {willSend ? 'Send' : 'Done'}
                                </Text>
                            </Pressable>
                    </DimDuringConfirm>
                    </>
                    )}
                    </ContentColumn>
                {/* LAYER 5 — close. Sibling of the control column (not
                    inside it) so it floats over the image at the screen's
                    own top-left, independent of the column's padding. */}
                <CloseButton
                    confirming={confirming}
                    onPress={handleSkip}
                />
            </Reanimated.View>
            </SafeAreaProvider>
        </Modal>
    );
}

const STAR_CELL_SIZE = 44;

const styles = StyleSheet.create({
    // No-backdrop fallback glyph: high in the frame (~22% down) rather than
    // screen-centred, so it sits where the image would read instead of
    // under the gradient's solid half and the controls.
    imageFallback: {
        ...StyleSheet.absoluteFillObject,
        alignItems: 'center',
        justifyContent: 'flex-start',
        paddingTop: '22%',
    },
    // The control column, over the image layers. Bottom-anchored so short
    // content (no-rec) sits low on solid ground and tall content (rec-fork)
    // grows upward toward the image. paddingTop is applied inline (it
    // depends on insets, to clear the close X); paddingBottom is animated
    // (keyboard-aware) via contentPadStyle.
    contentColumn: {
        flex: 1,
        justifyContent: 'flex-end',
        paddingHorizontal: spacing.base,
    },
    scroll: {
        flexShrink: 1,
    },
    // ONE lg (24) gap between every top-level group; groups keep their own
    // tighter internal rhythm. Replaces the old flat md (12) step between
    // every individual control, which made six unrelated rows read as one
    // undifferentiated list.
    //
    // flexGrow + flex-end BOTTOM-ANCHOR the content. The ScrollView fills
    // its slot rather than sizing to content, so without these the controls
    // pinned to the TOP of that viewport — floating up onto the bright part
    // of the image and leaving dead navy between them and the actions.
    // Growing the content container to fill and packing its children to the
    // end puts them directly above the pinned actions (whose own lg
    // paddingTop is the gap), with the image showing in the space above.
    // When content is TALLER than the viewport (rec-fork on a small phone)
    // there's no free space to distribute, so both properties are inert and
    // it scrolls exactly as before.
    // alignItems centre puts the poster, heading group and stars group on
    // one axis. Groups that need full width (the heading's text block, the
    // rec-fork block) opt back out with alignSelf 'stretch'.
    scrollContent: {
        flexGrow: 1,
        justifyContent: 'flex-end',
        alignItems: 'center',
        paddingTop: spacing.lg,
        gap: spacing.lg,
    },
    centredText: {
        textAlign: 'center',
    },
    // The prompt. Spreads `heading` to inherit its face (body semibold) and
    // only bumps the size — there's no 26pt tier in the type scale, and the
    // face is what separates it from the title above (display face at 22).
    // Bigger than the title on purpose: the title is what you're rating,
    // this is the question being asked, and the question should lead.
    question: {
        ...typography.heading,
        fontSize: 26,
        lineHeight: 32,
    },
    // Stretches so the centred question text has the full column width to
    // centre within — the DimDuringConfirm wrapper would otherwise shrink
    // to the text's own width inside actionGroup's alignItems: 'center'.
    questionWrap: {
        alignSelf: 'stretch',
    },
    // WHAT is being rated: poster → title → year · type. Nested so the
    // poster gets an md gap to the title block while the title and its
    // meta line stay tight (xs) — two different gaps need two containers.
    identityGroup: {
        alignSelf: 'stretch',
        alignItems: 'center',
        gap: spacing.md,
    },
    titleBlock: {
        alignSelf: 'stretch',
        alignItems: 'center',
        gap: spacing.xs,
    },
    // The ASK: question → stars → privacy row, as one unit.
    actionGroup: {
        alignSelf: 'stretch',
        alignItems: 'center',
        gap: spacing.md,
    },
    // Quiet centred row (label + switch side by side) rather than a
    // full-width space-between settings row — it has to read as an aside
    // under the stars, not as its own section.
    visibilityRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
    },
    // Rec-fork block: chips + share toggle + note, tight md rhythm inside.
    // Stretches so the note field and toggle row keep full width inside the
    // otherwise-centred column.
    recGroup: {
        alignSelf: 'stretch',
        gap: spacing.md,
    },
    // Icon + label, centred. Always rendered (while not note-focused) and
    // only faded, so its height is reserved at every rating — see the JSX.
    recommendLine: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
    },
    // The quieter sibling of Done: a bare accent link, centred above it.
    reviewLink: {
        alignSelf: 'center',
    },
    // Absolute wrapper carrying the position; `top` is applied inline (it
    // depends on the modal's own inset). Sits above the control column.
    closeButtonWrap: {
        position: 'absolute',
        // Top-RIGHT, matching the title page's close button exactly (same
        // corner, inset, 36pt circle and onImage.chip fill) so the control
        // doesn't jump when the rating screen opens over that page.
        right: spacing.base,
        zIndex: 10,
    },
    closeButton: {
        width: CLOSE_BUTTON_SIZE,
        height: CLOSE_BUTTON_SIZE,
        borderRadius: radius.full,
        alignItems: 'center',
        justifyContent: 'center',
    },
    // Pinned below the scroll — always on screen.
    actions: {
        paddingTop: spacing.lg,
        gap: spacing.lg,
    },
    // Sharp poster over the blurred backdrop. Explicit width so the
    // column's default `alignItems: stretch` can't stretch it — that's what
    // keeps it left-aligned without an alignSelf.
    // width/height are applied inline — they're derived from the available
    // height (posterWidthFor), which needs the modal's real insets.
    poster: {
        ...posterFrame,
        borderRadius: radius.sm,
    },
    chipsRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.sm,
    },
    chip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
        borderWidth: 1,
        borderRadius: radius.full,
        paddingLeft: spacing.xs,
        paddingRight: spacing.sm,
        paddingVertical: spacing.xs,
    },
    // marginTop dropped throughout this block — the group containers
    // (recGroup / actionGroup / actions) and scrollContent's gap own the
    // rhythm now, so individual controls carry no spacing of their own.
    toggleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    noteInput: {
        minHeight: 72,
        maxHeight: 140,
        borderRadius: radius.md,
        padding: spacing.md,
        textAlignVertical: 'top',
    },
    // Wraps the star row + the confirmation "★ N" overlay so the latter
    // centers over the same area as the row collapses out.
    ratingArea: {
        alignItems: 'center',
        justifyContent: 'center',
        // FIXED height — the star row's natural size (44 cell + sm padding
        // top and bottom), pinned so the beat can't resize it. The collapse
        // is a transform and the "★ N" overlay is absolute, so neither
        // affects layout today; stating the height explicitly means a later
        // change to either can't start nudging the column.
        height: STAR_CELL_SIZE + spacing.sm * 2,
    },
    confirmOverlay: {
        ...StyleSheet.absoluteFillObject,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: spacing.sm,
    },
    starsRow: {
        flexDirection: 'row',
        alignItems: 'center',
        // alignSelf shrinks the row to content width so onLayout reports
        // just the stars+gaps span — required for the drag-gesture
        // value mapping to line up with the visible stars.
        alignSelf: 'center',
        gap: spacing.xs,
        paddingVertical: spacing.sm,
    },
    starCell: {
        width: STAR_CELL_SIZE,
        height: STAR_CELL_SIZE,
        // relative wrapper; visual + two tap zones overlay inside.
    },
    starVisual: {
        ...StyleSheet.absoluteFillObject,
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'none',
    },
    starStack: {
        width: 36,
        height: 36,
    },
    halfOverlay: {
        ...StyleSheet.absoluteFillObject,
    },
    halfHit: {
        position: 'absolute',
        top: 0,
        bottom: 0,
        width: STAR_CELL_SIZE / 2,
    },
    halfLeft: {
        left: 0,
    },
    halfRight: {
        right: 0,
    },
    // Full-width now (was a centred, padded-to-content pill) — it's the
    // single filled-accent primary, and full width matches the outlined
    // Recommend button above it so the two read as one action stack.
    // Spacing is owned by `actions`.
    doneButton: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: button.paddingVertical,
        borderRadius: button.borderRadius,
    },
});
