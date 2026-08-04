import * as Haptics from 'expo-haptics';
import { Star, StarHalf } from 'lucide-react-native';
import { MotiView } from 'moti';
import { useEffect, useRef, useState } from 'react';
import {
    Alert,
    Dimensions,
    Modal,
    PanResponder,
    Pressable,
    StyleSheet,
    Text,
    TextInput,
    useColorScheme,
    View,
} from 'react-native';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Reanimated, {
    Easing,
    interpolate,
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { Toggle } from '@/components/toggle';
import { postRecComment } from '@/lib/comments';
import { setItemVisibility } from '@/lib/item-status';
import { applyWatchedRating, ratingGlyphs, type MediaType } from '@/lib/rating';
import { getReceivedRecsForTitle, type ReceivedRec } from '@/lib/recs';
import { maybeRequestReviewAfterRecRating } from '@/lib/review';
import supabase from '@/lib/supabase';
import {
    button,
    getPalette,
    ICON_STROKE_WIDTH,
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
    // null when they dismissed without committing (Skip, backdrop tap,
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

// Bottom-sheet open/close motion: backdrop fades (stationary) while the panel
// slides up — one shared `progress` value — matching DeclineSheet /
// RequestRecSheet. Keyboard-aware: the panel rides above the keyboard when the
// note field (added later) is focused, so the sheet is built on the same
// react-native-keyboard-controller scaffold rather than Modal's slide.
const AnimatedPressable = Reanimated.createAnimatedComponent(Pressable);
const OPEN_MS = 240;
const CLOSE_MS = 180;
// Max time to wait for the received-recs lookup before opening anyway. Fetch-
// before-open: the sheet slides up already knowing rec vs no-rec at its true
// final height, so nothing settles after the slide. Past this cap (slow fetch)
// it opens in the no-rec layout and the rec section appears when the fetch
// lands — a rare fallback.
const OPEN_MAX_WAIT_MS = 150;
// Confirmation beat duration — how long the "row collapses, ★ N pops" plays
// after Done before onSubmit fires (and the parent closes the sheet). The
// collapse timing + pop spring below are scaled to fill this window so the
// beat reads clearly rather than flashing past.
const CONFIRM_BEAT_MS = 1000;
// Collapse of the stars row (scales/fades toward center). ~60% of the beat,
// so the row is gone with a beat of breathing room before onSubmit fires.
const CONFIRM_COLLAPSE_MS = 600;

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

// Bottom-sheet star rating prompt used after a Watched transition.
// Caller controls visible / busy / initialRating; the sheet owns
// (a) the tentative selection the user is building toward Done and
// (b) the press-in fill preview that lights stars while the finger
// is down.
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
    const insets = useSafeAreaInsets();
    // Animated keyboard height (negative: 0 → -keyboardHeight) + progress (0
    // closed → 1 open) drive the panel's bottom padding so it docks above the
    // keyboard once the note field is focused — same scaffold as DeclineSheet.
    const { height: keyboardHeight, progress: keyboardProgress } =
        useReanimatedKeyboardAnimation();
    // Mounted only while opening/open (mounts when the fetch resolves, not on
    // `visible`); stays mounted through the close animation.
    const [mounted, setMounted] = useState(false);
    // 0 = closed (backdrop transparent, panel off-screen), 1 = open. Starts
    // closed — the open effect drives it once the fetch settles.
    const progress = useSharedValue(0);
    // 1 while open/settling, 0 the instant dismissal starts — freezes the
    // keyboard-driven padding (frozenPad) so nothing reflows during the exit.
    const active = useSharedValue(0);
    const frozenPad = useSharedValue(insets.bottom + spacing.lg);
    // Panel height drives the slide distance; tall fallback until first
    // onLayout so the panel starts fully off-screen.
    const [sheetHeight, setSheetHeight] = useState(
        Dimensions.get('window').height,
    );
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

        (async () => {
            try {
                if (tmdbId === null || mediaType === null) {
                    if (!cancelled) setReceived([]);
                    return;
                }
                const {
                    data: { session },
                } = await supabase.auth.getSession();
                const uid = session?.user.id ?? null;
                if (!uid) {
                    if (!cancelled) setReceived([]);
                    return;
                }
                const [recs, itemRow] = await Promise.all([
                    getReceivedRecsForTitle(uid, tmdbId, mediaType),
                    supabase
                        .from('items')
                        .select('visibility')
                        .eq('user_id', uid)
                        .eq('tmdb_id', tmdbId)
                        .eq('media_type', mediaType)
                        .maybeSingle(),
                ]);
                if (cancelled) return;
                const isPrivate = itemRow.data?.visibility === 'private';
                setCurrentUserId(uid);
                setReceived(recs);
                setSelectedSenderIds(new Set(recs.map((r) => r.fromUserId)));
                setInitialPrivate(isPrivate);
                setHiddenFromFriends(isPrivate);
            } catch (err) {
                console.warn('rating sheet: received recs fetch failed', err);
                if (!cancelled) setReceived([]);
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

    const backdropStyle = useAnimatedStyle(() => ({ opacity: progress.value }));
    // Panel slide (translateY) always runs — it IS the exit animation. The
    // keyboard-driven bottom padding lifts content above the keyboard
    // (-keyboardHeight) plus a constant lg gap, minus the home-indicator inset
    // as the keyboard rises. While dismissing (active === 0) it holds frozenPad
    // so the exit is a pure slide with no reflow.
    const sheetStyle = useAnimatedStyle(() => {
        const translateY = interpolate(progress.value, [0, 1], [sheetHeight, 0]);
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
        return { transform: [{ translateY }], paddingBottom };
    });

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
    const panResponder = useRef(
        PanResponder.create({
            onStartShouldSetPanResponder: () => false,
            onMoveShouldSetPanResponder: (_, g) =>
                Math.abs(g.dx) > DRAG_THRESHOLD_PX ||
                Math.abs(g.dy) > DRAG_THRESHOLD_PX,
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
    // a rating, a non-empty note, or a privacy change. All-empty → use Skip.
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
            onRequestClose={handleSkip}
        >
            <View style={styles.backdrop}>
                {/* Backdrop: fades only, never moves. */}
                <AnimatedPressable
                    style={[
                        StyleSheet.absoluteFill,
                        { backgroundColor: palette.overlay },
                        backdropStyle,
                    ]}
                    onPress={handleSkip}
                />
                {/* Panel: slides up; on top of the backdrop so taps on it
                    don't fall through to dismiss. */}
                <Reanimated.View
                    onLayout={(e) =>
                        setSheetHeight(e.nativeEvent.layout.height)
                    }
                    style={[
                        styles.sheet,
                        { backgroundColor: palette.surface },
                        sheetStyle,
                    ]}
                >
                    {/* Header + chips. The received-recs lookup runs before the
                        open slide (fetch-before-open), so headerText / recs are
                        already correct here — no fade gate needed; the sheet
                        opens at its true final height. */}
                    <Text
                        style={[
                            typography.heading,
                            styles.title,
                            { color: palette.text },
                        ]}
                    >
                        {headerText}
                    </Text>
                    {/* Rec case with multiple senders: recipient chips, all
                        pre-selected, tap to toggle who the note goes to. */}
                    {showChips && !confirming ? (
                        <View style={styles.chipsRow}>
                            {recs.map((r) => {
                                const on = selectedSenderIds.has(r.fromUserId);
                                return (
                                    <Pressable
                                        key={r.fromUserId}
                                        onPress={() =>
                                            toggleSender(r.fromUserId)
                                        }
                                        disabled={busy}
                                        accessibilityRole="button"
                                        accessibilityState={{ selected: on }}
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
                                            avatarUrl={r.sender.avatarUrl}
                                            displayName={r.sender.displayName}
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
                                            {firstNameOf(r.sender.displayName)}
                                        </Text>
                                    </Pressable>
                                );
                            })}
                        </View>
                    ) : null}
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
                                                fill={palette.accent}
                                                size={36}
                                                strokeWidth={ICON_STROKE_WIDTH}
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
                                                    fill="transparent"
                                                    size={36}
                                                    strokeWidth={ICON_STROKE_WIDTH}
                                                />
                                                <View style={styles.halfOverlay}>
                                                    <StarHalf
                                                        color={palette.accent}
                                                        fill={palette.accent}
                                                        size={36}
                                                        strokeWidth={
                                                            ICON_STROKE_WIDTH
                                                        }
                                                    />
                                                </View>
                                            </View>
                                        ) : (
                                            <Star
                                                color={palette.textMuted}
                                                fill="transparent"
                                                size={36}
                                                strokeWidth={ICON_STROKE_WIDTH}
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
                                fill={palette.accent}
                                size={40}
                                strokeWidth={ICON_STROKE_WIDTH}
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
                    {/* Done / Skip hide during the confirmation beat so the
                        "★ N" stands alone before the sheet closes. */}
                    {!confirming ? (
                        <>
                            {/* Note + toggles. Content is known before the open
                                slide (fetch-before-open), so recFork / placeholder
                                are correct here — no fade gate. */}
                            {/* Rec case (and not private): append the rating to
                                the comment when ON. Default ON. Beneath the
                                stars; collapses when Hidden-from-friends is ON. */}
                            {recFork ? (
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
                            ) : null}
                            {/* Note only in the rec fork — it posts to the
                                sender's rec (2a). Outside it (no-rec, or a
                                private rec) there's no target, so no field. */}
                            {recFork ? (
                                <TextInput
                                    value={note}
                                    onChangeText={(v) =>
                                        setNote(v.slice(0, NOTE_MAX))
                                    }
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
                                            backgroundColor: palette.bg,
                                        },
                                    ]}
                                />
                            ) : null}
                            {/* Privacy — marks the item private. Default OFF.
                                Shown in both cases; ON collapses the rec
                                framing above (chips + share-rating toggle). */}
                            <View style={styles.toggleRow}>
                                <Text
                                    style={[
                                        typography.body,
                                        { color: palette.text },
                                    ]}
                                >
                                    Visible to friends
                                </Text>
                                {/* Unified polarity app-wide: ON = shared,
                                    OFF = private — same phrasing + switch
                                    direction as the title page's row. The
                                    internal state (hiddenFromFriends) and
                                    the write path are unchanged; only the
                                    label and switch direction flipped. */}
                                <Toggle
                                    value={!hiddenFromFriends}
                                    onValueChange={(v) =>
                                        setHiddenFromFriends(!v)
                                    }
                                    palette={palette}
                                    disabled={busy}
                                />
                            </View>
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
                            <Pressable
                                onPress={handleSkip}
                                disabled={busy || submitting}
                                style={({ pressed }) => [
                                    styles.skipButton,
                                    {
                                        opacity:
                                            pressed || busy || submitting
                                                ? 0.6
                                                : 1,
                                    },
                                ]}
                            >
                                <Text
                                    style={[
                                        typography.bodyEmphasis,
                                        { color: palette.textMuted },
                                    ]}
                                >
                                    Skip
                                </Text>
                            </Pressable>
                        </>
                    ) : null}
                </Reanimated.View>
            </View>
        </Modal>
    );
}

const STAR_CELL_SIZE = 44;

const styles = StyleSheet.create({
    backdrop: {
        flex: 1,
        justifyContent: 'flex-end',
    },
    sheet: {
        borderTopLeftRadius: radius.xl,
        borderTopRightRadius: radius.xl,
        paddingHorizontal: spacing.base,
        paddingTop: spacing.lg,
        // paddingBottom is animated (keyboard-aware) via sheetStyle.
    },
    title: {
        textAlign: 'center',
        marginBottom: spacing.lg,
    },
    chipsRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'center',
        gap: spacing.sm,
        marginBottom: spacing.base,
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
    toggleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginTop: spacing.md,
    },
    noteInput: {
        minHeight: 72,
        maxHeight: 140,
        borderRadius: radius.md,
        padding: spacing.md,
        textAlignVertical: 'top',
        marginTop: spacing.md,
    },
    // Wraps the star row + the confirmation "★ N" overlay so the latter
    // centers over the same area as the row collapses out.
    ratingArea: {
        alignItems: 'center',
        justifyContent: 'center',
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
    doneButton: {
        alignSelf: 'center',
        marginTop: spacing.md,
        paddingHorizontal: spacing.xl,
        paddingVertical: button.paddingVertical,
        borderRadius: button.borderRadius,
    },
    skipButton: {
        alignSelf: 'center',
        paddingHorizontal: spacing.base,
        paddingVertical: spacing.md,
        marginTop: spacing.sm,
    },
});
