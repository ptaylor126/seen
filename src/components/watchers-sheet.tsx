import { Image } from 'expo-image';
import { Check, ChevronRight, MessageCircle } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import {
    Animated,
    Dimensions,
    Easing,
    Modal,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    useColorScheme,
    View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { ratingGlyphs } from '@/lib/rating';
import { imageUrl } from '@/lib/tmdb';
import {
    getPalette,
    ICON_STROKE_WIDTH,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

// One friend who watched the title. `rating` is the stored 1-10 value
// (null when they watched without rating). Same shape the title screen's
// friends-watched card is built from, so the sheet's set can't drift from
// the card's.
export interface WatcherSheetItem {
    userId: string;
    // Profile handle — the key the /friends/[handle] route navigates by
    // (tapping a row opens that friend's profile). Required for the row
    // tap; userId alone can't address the profile route.
    handle: string;
    displayName: string;
    avatarUrl: string | null;
    rating: number | null;
    // True when this watcher has a non-dismissed recommendation of this title
    // to the current user. Set by getFriendsWhoWatched; optional because other
    // constructors (e.g. the "friends watching" set) don't compute it. The
    // "who to talk to" prompts (overlap row + banners) filter these out; the
    // "who has seen this" surfaces (watched-by list, picker) keep them.
    recommendedToMe?: boolean;
}

interface WatchersSheetProps {
    visible: boolean;
    watchers: WatcherSheetItem[];
    onClose: () => void;
    // Tapping a watcher row — the screen owns what that means (keeps routing
    // out of this presentational sheet). The title page's cards open the
    // watcher's profile; the overlap flows open/start a chat with them.
    // Receives the full item so either intent has what it needs.
    onSelectWatcher: (watcher: WatcherSheetItem) => void;
    // Quick-send chips. Each chip sends one message (→ onQuickSend) and
    // "Write…" opens the compose path (→ onWriteYourOwn). No message is
    // ever sent without the user seeing the chips first — read-then-tap.
    //
    // Two presentations, by `expandable`:
    //   - expandable: false/omitted — ONE chip strip pinned at the sheet's
    //     bottom, acting on the SELECTED watcher (the overlap pickers: the
    //     sheet exists to send). Rows are identity-only and tap to select
    //     (selected state shown); a single-watcher list is pre-selected so
    //     it stays one-tap. onSelectWatcher is unused. This avoids the
    //     repeated-per-row chip strips reading as canned.
    //   - expandable: true — chips are hidden behind a chat-icon EXPANDER;
    //     the row stays a tappable profile link (onSelectWatcher), tapping
    //     the icon reveals that row's chips inline, ONE row open at a time
    //     (the browse sheets: the sheet exists to browse; the icon opens
    //     the send affordance).
    quickChips?: {
        messages: string[];
        onQuickSend: (watcher: WatcherSheetItem, message: string) => void;
        onWriteYourOwn: (watcher: WatcherSheetItem) => void;
        expandable?: boolean;
    };
    // Sheet heading. Defaults to the original "Watched by"; the title
    // screen's Friends-watching card reuses this same sheet with
    // "Watching" (its rows simply have no rating — `rating: null` rows
    // already render name-only).
    title?: string;
    // Optional tappable title card at the top of the sheet (poster + name +
    // caption + chevron), routing through to the title page — so the
    // overlap picker reaches BOTH the watchers (primary) and the title.
    // The caller owns onPress (closes the sheet + navigates).
    titleHeader?: {
        title: string;
        caption: string;
        posterPath: string | null;
        onPress: () => void;
    };
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const OPEN_MS = 240;
const CLOSE_MS = 180;

// Bottom sheet listing everyone who watched a title — opened from the
// friends-watched card (which only shows the first few avatars). Standard
// bottom-sheet motion: the backdrop FADES (stationary) while the panel
// SLIDES up from the bottom — driven by one Animated value rather than
// Modal's animationType="slide" (which slides backdrop + panel together).
// The Modal stays mounted through the close animation, then unmounts.
export function WatchersSheet({
    visible,
    watchers,
    onClose,
    onSelectWatcher,
    quickChips,
    titleHeader,
    title = 'Watched by',
}: WatchersSheetProps) {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const insets = useSafeAreaInsets();

    // Cap the scroll area at half the screen so a long list doesn't push
    // the sheet to full height (and the backdrop stays reachable).
    const listMaxHeight = Dimensions.get('window').height * 0.5;

    // Which row's chips are expanded, in the EXPANDABLE browse-sheet mode —
    // one at a time (tapping another row's icon moves the reveal there).
    const [expandedUserId, setExpandedUserId] = useState<string | null>(null);
    // Which watcher the bottom chip bar acts on, in the SHEET-LEVEL select
    // mode (overlap pickers). A single-watcher list pre-selects that one so
    // the bar stays one-tap; a multi list starts unselected until a row is
    // tapped.
    const soleWatcherId =
        watchers.length === 1 ? watchers[0].userId : null;
    const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
    // Reset transient row state on open/close: collapse expanders, and seed
    // the selection to the sole watcher (or clear it). soleWatcherId in the
    // deps re-seeds if the list resolves async (e.g. the inbox picker's
    // fetch lands after the sheet opens).
    useEffect(() => {
        if (!visible) {
            setExpandedUserId(null);
            setSelectedUserId(null);
            return;
        }
        setSelectedUserId(soleWatcherId);
    }, [visible, soleWatcherId]);

    const selectedWatcher =
        watchers.find((w) => w.userId === selectedUserId) ?? null;

    // The quick-send chip strip for one watcher — shared by the expandable
    // rows (per-row, revealed) and the sheet-level bottom bar (on the
    // selected watcher). Null when the sheet isn't in a chip mode.
    const chipStripFor = (w: WatcherSheetItem) =>
        quickChips ? (
            <View style={styles.chipStrip}>
                {quickChips.messages.map((m) => (
                    <Pressable
                        key={m}
                        onPress={() => quickChips.onQuickSend(w, m)}
                        accessibilityRole="button"
                        accessibilityLabel={`Send "${m}" to ${w.displayName}`}
                        style={({ pressed }) => [
                            styles.messageChip,
                            { backgroundColor: palette.accentWash },
                            pressed && { opacity: 0.6 },
                        ]}
                    >
                        <Text
                            style={[
                                typography.caption,
                                styles.messageChipText,
                                { color: palette.accent },
                            ]}
                            numberOfLines={1}
                        >
                            {m}
                        </Text>
                    </Pressable>
                ))}
                {/* Write-your-own → the compose path (custom words).
                    Quieter than the message chips: no fill, muted, with
                    the chat glyph. */}
                <Pressable
                    onPress={() => quickChips.onWriteYourOwn(w)}
                    accessibilityRole="button"
                    accessibilityLabel={`Write your own message to ${w.displayName}`}
                    style={({ pressed }) => [
                        styles.writeChip,
                        pressed && { opacity: 0.6 },
                    ]}
                >
                    <MessageCircle
                        color={palette.textMuted}
                        size={14}
                        strokeWidth={ICON_STROKE_WIDTH}
                    />
                    <Text
                        style={[
                            typography.caption,
                            { color: palette.textMuted },
                        ]}
                    >
                        Write…
                    </Text>
                </Pressable>
            </View>
        ) : null;

    // Keep the Modal mounted while the close animation plays.
    const [mounted, setMounted] = useState(visible);
    // 0 = closed (backdrop transparent, panel off-screen), 1 = open.
    const progress = useRef(new Animated.Value(visible ? 1 : 0)).current;
    // Panel height drives the slide distance; falls back to a tall value
    // until first onLayout so the panel starts fully off-screen.
    const [sheetHeight, setSheetHeight] = useState(
        Dimensions.get('window').height,
    );

    useEffect(() => {
        if (visible) {
            setMounted(true);
            Animated.timing(progress, {
                toValue: 1,
                duration: OPEN_MS,
                easing: Easing.out(Easing.cubic),
                useNativeDriver: true,
            }).start();
        } else {
            Animated.timing(progress, {
                toValue: 0,
                duration: CLOSE_MS,
                easing: Easing.in(Easing.cubic),
                useNativeDriver: true,
            }).start(({ finished }) => {
                if (finished) setMounted(false);
            });
        }
    }, [visible, progress]);

    const translateY = progress.interpolate({
        inputRange: [0, 1],
        outputRange: [sheetHeight, 0],
    });

    return (
        <Modal
            visible={mounted}
            transparent
            animationType="none"
            onRequestClose={onClose}
        >
            <View style={styles.container}>
                {/* Backdrop: fades only, never moves. */}
                <AnimatedPressable
                    style={[
                        StyleSheet.absoluteFill,
                        { backgroundColor: palette.overlay, opacity: progress },
                    ]}
                    onPress={onClose}
                />
                {/* Panel: slides up; sits on top of the backdrop so taps on
                    it don't fall through to the dismiss. */}
                <Animated.View
                    onLayout={(e) =>
                        setSheetHeight(e.nativeEvent.layout.height)
                    }
                    style={[
                        styles.sheet,
                        {
                            backgroundColor: palette.surface,
                            paddingBottom: insets.bottom + spacing.lg,
                            transform: [{ translateY }],
                        },
                    ]}
                >
                    <Text
                        style={[
                            typography.heading,
                            styles.title,
                            { color: palette.text },
                        ]}
                    >
                        {title}
                    </Text>
                    {/* Tappable title card → the title page (overlap
                        picker). Poster + name + type + chevron, matching
                        the chat screen's title-card pattern. */}
                    {titleHeader ? (
                        <Pressable
                            onPress={titleHeader.onPress}
                            accessibilityRole="link"
                            accessibilityLabel={`View details for ${titleHeader.title}`}
                            style={({ pressed }) => [
                                styles.titleHeader,
                                { backgroundColor: palette.surfaceAlt },
                                pressed && { opacity: 0.7 },
                            ]}
                        >
                            {titleHeader.posterPath ? (
                                <Image
                                    source={{
                                        uri: imageUrl(
                                            titleHeader.posterPath,
                                            'w185',
                                        ),
                                    }}
                                    style={styles.titleHeaderPoster}
                                    contentFit="cover"
                                    transition={150}
                                />
                            ) : (
                                <View
                                    style={[
                                        styles.titleHeaderPoster,
                                        { backgroundColor: palette.border },
                                    ]}
                                />
                            )}
                            <View style={styles.titleHeaderText}>
                                <Text
                                    style={[
                                        typography.bodyEmphasis,
                                        { color: palette.text },
                                    ]}
                                    numberOfLines={2}
                                >
                                    {titleHeader.title}
                                </Text>
                                <Text
                                    style={[
                                        typography.caption,
                                        { color: palette.textMuted },
                                    ]}
                                >
                                    {titleHeader.caption}
                                </Text>
                            </View>
                            <ChevronRight
                                color={palette.textMuted}
                                size={18}
                                strokeWidth={ICON_STROKE_WIDTH}
                            />
                        </Pressable>
                    ) : null}
                    <ScrollView
                        style={{ maxHeight: listMaxHeight }}
                        contentContainerStyle={styles.listContent}
                        showsVerticalScrollIndicator={false}
                    >
                        {watchers.map((w) => {
                            // Identity block — avatar + name + rating tight
                            // together. Shared by every row mode.
                            const identity = (
                                <>
                                    <Avatar
                                        avatarUrl={w.avatarUrl}
                                        displayName={w.displayName}
                                        seedId={w.userId}
                                        size={40}
                                    />
                                    {/* Name + rating grouped TIGHT (rating
                                        sits right after the name, not pushed
                                        to the far edge) so the two read as
                                        one unit — "who, and how they rated
                                        it". flex:1 fills the width. */}
                                    <View style={styles.nameGroup}>
                                        <Text
                                            style={[
                                                typography.bodyEmphasis,
                                                styles.name,
                                                { color: palette.text },
                                            ]}
                                            numberOfLines={1}
                                        >
                                            {w.displayName}
                                        </Text>
                                        {w.rating !== null ? (
                                            <Text
                                                style={[
                                                    typography.caption,
                                                    styles.rating,
                                                    { color: palette.accent },
                                                ]}
                                                numberOfLines={1}
                                            >
                                                {ratingGlyphs(w.rating)}
                                            </Text>
                                        ) : null}
                                    </View>
                                </>
                            );

                            // Sheet-level select mode (overlap pickers): row
                            // taps to SELECT; selection is shown ONLY by a
                            // white check in a plum circle on the right —
                            // no row fill. The bottom bar's chips act on the
                            // selection. No per-row chips, so no repetition.
                            if (quickChips && !quickChips.expandable) {
                                const selected = selectedUserId === w.userId;
                                return (
                                    <Pressable
                                        key={w.userId}
                                        onPress={() =>
                                            setSelectedUserId(w.userId)
                                        }
                                        accessibilityRole="button"
                                        accessibilityState={{ selected }}
                                        accessibilityLabel={`Select ${w.displayName}`}
                                        style={({ pressed }) => [
                                            styles.row,
                                            pressed && { opacity: 0.6 },
                                        ]}
                                    >
                                        {identity}
                                        {selected ? (
                                            <View
                                                style={[
                                                    styles.selectCheck,
                                                    {
                                                        backgroundColor:
                                                            palette.accent,
                                                    },
                                                ]}
                                            >
                                                <Check
                                                    color={palette.textInverse}
                                                    size={14}
                                                    strokeWidth={
                                                        ICON_STROKE_WIDTH
                                                    }
                                                />
                                            </View>
                                        ) : null}
                                    </Pressable>
                                );
                            }

                            // Expandable chips (browse sheets): the sheet
                            // exists to browse, so the row stays a tappable
                            // profile link and a chat-icon EXPANDER reveals
                            // this row's chips inline — read-then-tap, no
                            // silent send. One row open at a time.
                            if (quickChips) {
                                const expanded = expandedUserId === w.userId;
                                return (
                                    <View key={w.userId} style={styles.chipRow}>
                                        <Pressable
                                            onPress={() => onSelectWatcher(w)}
                                            accessibilityRole="button"
                                            accessibilityLabel={`View ${w.displayName}'s profile`}
                                            style={({ pressed }) => [
                                                styles.row,
                                                pressed && { opacity: 0.6 },
                                            ]}
                                        >
                                            {identity}
                                            {/* Expander — reveals/hides this
                                                row's chips. Nested Pressable
                                                captures its own tap before the
                                                profile row. Accent when open. */}
                                            <Pressable
                                                onPress={() =>
                                                    setExpandedUserId(
                                                        expanded
                                                            ? null
                                                            : w.userId,
                                                    )
                                                }
                                                hitSlop={spacing.sm}
                                                accessibilityRole="button"
                                                accessibilityState={{
                                                    expanded,
                                                }}
                                                accessibilityLabel={`Message ${w.displayName}`}
                                                style={({ pressed }) => [
                                                    styles.chatIcon,
                                                    pressed && { opacity: 0.5 },
                                                ]}
                                            >
                                                <MessageCircle
                                                    color={
                                                        expanded
                                                            ? palette.accent
                                                            : palette.textMuted
                                                    }
                                                    size={20}
                                                    strokeWidth={
                                                        ICON_STROKE_WIDTH
                                                    }
                                                />
                                            </Pressable>
                                        </Pressable>
                                        {expanded ? chipStripFor(w) : null}
                                    </View>
                                );
                            }

                            // No plain (no-quickChips) mode: every caller —
                            // the overlap pickers and the browse sheets — passes
                            // quickChips, so a chip-less row is never rendered.
                            // (It used to be a profile-looking row labelled
                            // "View … profile" whose tap actually opened a chat
                            // — an affordance that lied.) The callback must
                            // still return for the impossible !quickChips case:
                            // render nothing.
                            return null;
                        })}
                    </ScrollView>
                    {/* Sheet-level chip bar — select mode only. Pinned below
                        the list; acts on the selected watcher. A single-
                        watcher list is pre-selected, so it's one-tap; a
                        multi list shows a prompt until a row is picked. */}
                    {quickChips && !quickChips.expandable ? (
                        <View
                            style={[
                                styles.footerBar,
                                { borderTopColor: palette.border },
                            ]}
                        >
                            {selectedWatcher ? (
                                chipStripFor(selectedWatcher)
                            ) : (
                                <Text
                                    style={[
                                        typography.caption,
                                        styles.footerHint,
                                        { color: palette.textMuted },
                                    ]}
                                >
                                    Tap a name to message them.
                                </Text>
                            )}
                        </View>
                    ) : null}
                </Animated.View>
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        justifyContent: 'flex-end',
    },
    sheet: {
        borderTopLeftRadius: radius.xl,
        borderTopRightRadius: radius.xl,
        paddingHorizontal: spacing.base,
        paddingTop: spacing.lg,
    },
    title: {
        textAlign: 'center',
        marginBottom: spacing.base,
    },
    // Tappable title card above the list (overlap picker). Poster + text +
    // chevron on a soft surface, matching the chat screen's title card.
    titleHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        padding: spacing.sm,
        borderRadius: radius.md,
        marginBottom: spacing.base,
    },
    titleHeaderPoster: {
        width: 44,
        height: 66,
        borderRadius: radius.sm / 2,
    },
    titleHeaderText: {
        flex: 1,
        gap: spacing.xs,
    },
    listContent: {
        gap: spacing.md,
        paddingVertical: spacing.xs,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
    },
    // Name + rating as one left-aligned unit; takes the row width so the
    // chat icon (when present) sits at the far right.
    nameGroup: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
    },
    name: {
        // Shrinkable so a long name truncates BEFORE crowding the rating
        // beside it (flexShrink, not flex:1 — the rating keeps its size).
        flexShrink: 1,
    },
    rating: {
        // Medium weight so the stars read as a value, not body text.
        fontWeight: '500',
        flexShrink: 0,
    },
    chatIcon: {
        padding: spacing.xs,
    },
    // Selected marker (sheet-level select mode): a white check in a filled
    // plum circle on the row's right — the ONLY selection affordance (no
    // row fill). 24pt circle sized to the 14pt glyph.
    selectCheck: {
        width: 24,
        height: 24,
        borderRadius: radius.full,
        alignItems: 'center',
        justifyContent: 'center',
    },
    // Expandable-row wrapper: identity line stacked above the revealed chip
    // strip (listContent's gap separates rows).
    chipRow: {
        gap: spacing.sm,
    },
    // Quick-message chips + Write… on one wrapping line. Flush-left so it
    // aligns whether under an expandable row or in the sheet-level bar.
    chipStrip: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: spacing.sm,
    },
    messageChip: {
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.xs,
        borderRadius: radius.full,
    },
    messageChipText: {
        fontWeight: '500',
    },
    writeChip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
        paddingHorizontal: spacing.sm,
        paddingVertical: spacing.xs,
    },
    // Pinned chip bar at the sheet bottom (select mode). Hairline divider
    // above it, breathing room around the chips / prompt.
    footerBar: {
        borderTopWidth: StyleSheet.hairlineWidth,
        paddingTop: spacing.base,
        marginTop: spacing.sm,
    },
    footerHint: {
        textAlign: 'center',
        paddingVertical: spacing.xs,
    },
});
