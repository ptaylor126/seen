import { Fragment, useRef, useState } from 'react';
import {
    Pressable,
    StyleSheet,
    Text,
    useColorScheme,
    View,
    type StyleProp,
    type ViewStyle,
} from 'react-native';

import { ReactionBadge } from '@/components/thread/reaction-badge';
import {
    type CommentMenuTarget,
    type CommentRow,
    formatMessageTime,
    type ReactionRow,
    TIME_SEPARATOR_GAP_MS,
} from '@/components/thread/shared';
import { getPalette, radius, spacing, typography } from '@/theme/theme';

// A post-watched comment's body is `${note}\n\nGave it ★★★★` (or just the
// rating line when there's no note / rating-only). Split the trailing rating
// line off so it renders as its own styled sibling instead of a \n\n blank
// gap. Only a tail after the LAST "\n\n" that starts with a rating lead-in
// counts — a typed note may contain its own blank lines. note is null when the
// whole body is the rating line; ratingLine is null when there's nothing to
// split.
//
// Both lead-ins are recognised: "Gave it " (current) and "I gave it " (older
// comments stored before the wording change) so already-posted rows still split.
const RATING_LINE_PREFIXES = ['Gave it ', 'I gave it '];
function ratingLinePrefixOf(line: string): string | null {
    return RATING_LINE_PREFIXES.find((p) => line.startsWith(p)) ?? null;
}
function splitWatchedBody(body: string): {
    note: string | null;
    ratingLine: string | null;
} {
    const sep = body.lastIndexOf('\n\n');
    if (sep !== -1) {
        const tail = body.slice(sep + 2);
        if (ratingLinePrefixOf(tail) !== null) {
            const head = body.slice(0, sep);
            return { note: head.length > 0 ? head : null, ratingLine: tail };
        }
    }
    if (ratingLinePrefixOf(body) !== null) {
        return { note: null, ratingLine: body };
    }
    return { note: body, ratingLine: null };
}

// Chat-bubble thread rendering (shared by the chat screen and the rec
// page's comment thread). Own messages: right-aligned, accent fill, white
// text. The other party's: left-aligned, surface fill, dark text. NO
// avatars/names on bubbles — alignment + color carry identity. No always-on
// timestamps: a centered time separator appears between messages more than
// TIME_SEPARATOR_GAP_MS apart (and before the first); tapping a bubble
// toggles its exact send time; long-press opens the menu as before.
// Reactions render as a small badge overlapping the bubble's inner top
// corner (iMessage-style) instead of the old below-body chips — same data,
// same live updates, visual only.
export function ThreadCommentList({
    comments,
    myUserId,
    commentReactions,
    onLongPressComment,
    style,
}: {
    comments: CommentRow[];
    myUserId: string | null;
    // comment_id → reactions on that comment (O(1) lookups in the render path).
    commentReactions: Map<string, ReactionRow[]>;
    // Long-press → the screen opens the comment menu popover at this anchor.
    onLongPressComment: (target: CommentMenuTarget) => void;
    // Container override, merged AFTER the default. Used by the rec screen
    // to tighten the thread's top margin when nothing renders above it
    // (sender view, no note) so the first time separator sits close under
    // the hero. Layout only — rows are untouched.
    style?: StyleProp<ViewStyle>;
}) {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    // Per-bubble refs so a long-press can measureInWindow the pressed
    // bubble's true screen position (the menu anchors to it).
    const bubbleRefs = useRef(new Map<string, View>());
    // Which bubble has its exact send time revealed (tap toggles; tapping
    // another bubble moves the reveal there).
    const [expandedTimeId, setExpandedTimeId] = useState<string | null>(null);

    return (
        <View style={[styles.commentsList, style]}>
            {comments.map((c, i) => {
                const isMine = !!myUserId && c.userId === myUserId;
                // Time separator between message groups: before the first
                // message, and whenever the gap from the previous one is
                // meaningful.
                const prev = i > 0 ? comments[i - 1] : null;
                const showSeparator =
                    !prev ||
                    new Date(c.createdAt).getTime() -
                        new Date(prev.createdAt).getTime() >=
                        TIME_SEPARATOR_GAP_MS;
                const cReactionList = commentReactions.get(c.id) ?? [];
                // Same-sender clustering: consecutive messages from one
                // sender sit close (a run reads as one turn — but each
                // message keeps its own beat; 2px merged runs into a dense
                // block, 12px dissolved them), and the gap widens when the
                // sender changes or a time separator intervenes. The
                // reaction badge deliberately does NOT affect these margins:
                // it's an absolute overlay that floats into the existing
                // gap (iMessage-style), so a reacted message has the same
                // vertical footprint as a plain one.
                const clustered =
                    !!prev && prev.userId === c.userId && !showSeparator;
                // 6 = the beat between xs(4) and sm(8) — deliberate
                // in-between rhythm value. Rows directly under a time
                // separator (the thread's first message always is) get
                // base(16) instead of md(12): explicit headroom for the
                // reaction badge's upward overhang, so a badge on the
                // first message has clear space above its bubble.
                const rowMarginTop = showSeparator
                    ? spacing.base
                    : clustered
                      ? 6
                      : spacing.md;
                // Watched-sheet comments carry the rating as a trailing
                // "Gave it ★★★★" line — split it out so it renders as its
                // own styled line inside the bubble rather than a \n\n
                // blank gap.
                const watchedParts = c.fromWatched
                    ? splitWatchedBody(c.body)
                    : null;
                // Rating-only watched comment (no note) → the "watched"
                // caption and the rating line would be two near-identical
                // lines, so collapse to a single "watched · ★★★★" (glyphs
                // only, dropping the rating lead-in).
                const collapsedWatchedStars =
                    watchedParts &&
                    watchedParts.note === null &&
                    watchedParts.ratingLine !== null
                        ? watchedParts.ratingLine.slice(
                              (
                                  ratingLinePrefixOf(watchedParts.ratingLine) ??
                                  ''
                              ).length,
                          )
                        : null;
                // Side-dependent colors: the plum accent lines are invisible
                // on an own (accent-filled) bubble, so own bubbles render
                // body AND the watched/rating lines in the inverse color.
                const bodyColor = isMine ? palette.textInverse : palette.text;
                const specialColor = isMine
                    ? palette.textInverse
                    : palette.accent;
                return (
                    <Fragment key={c.id}>
                        {showSeparator ? (
                            <Text
                                style={[
                                    typography.caption,
                                    styles.timeSeparator,
                                    { color: palette.textMuted },
                                ]}
                            >
                                {formatMessageTime(c.createdAt)}
                            </Text>
                        ) : null}
                        <View
                            style={[
                                styles.bubbleRow,
                                isMine ? styles.rowMine : styles.rowTheirs,
                                { marginTop: rowMarginTop },
                            ]}
                        >
                            <Pressable
                                ref={(node) => {
                                    if (node)
                                        bubbleRefs.current.set(c.id, node);
                                    else bubbleRefs.current.delete(c.id);
                                }}
                                onPress={() =>
                                    setExpandedTimeId((cur) =>
                                        cur === c.id ? null : c.id,
                                    )
                                }
                                onLongPress={(e) => {
                                    // Anchor the menu to the BUBBLE, not the
                                    // touch point: measure the bubble's true
                                    // top in window space so the menu sits a
                                    // consistent gap above the message
                                    // regardless of where inside it the press
                                    // landed. Fall back to the touch pageY if
                                    // the node ref isn't available.
                                    const pageY = e.nativeEvent.pageY;
                                    const open = (anchorY: number) =>
                                        onLongPressComment({
                                            commentId: c.id,
                                            anchorY,
                                            isOwn: isMine,
                                            authorId: c.userId,
                                        });
                                    const node = bubbleRefs.current.get(c.id);
                                    if (node) {
                                        node.measureInWindow((_x, y) =>
                                            open(y),
                                        );
                                    } else {
                                        open(pageY);
                                    }
                                }}
                                style={[
                                    styles.bubble,
                                    isMine
                                        ? styles.bubbleMine
                                        : styles.bubbleTheirs,
                                    {
                                        backgroundColor: isMine
                                            ? palette.accent
                                            : palette.surface,
                                    },
                                ]}
                            >
                                {/* Quiet "watched" caption for post-watched-
                                    sheet comments — hidden in the no-note
                                    case, where it merges into the single
                                    collapsed line below. */}
                                {c.fromWatched && !collapsedWatchedStars ? (
                                    <Text
                                        style={[
                                            typography.caption,
                                            { color: specialColor },
                                        ]}
                                    >
                                        watched
                                    </Text>
                                ) : null}
                                {collapsedWatchedStars ? (
                                    <Text
                                        style={[
                                            typography.caption,
                                            { color: specialColor },
                                        ]}
                                    >
                                        watched · {collapsedWatchedStars}
                                    </Text>
                                ) : watchedParts ? (
                                    <>
                                        {watchedParts.note !== null ? (
                                            <Text
                                                style={[
                                                    typography.body,
                                                    {
                                                        color: bodyColor,
                                                        // Bubble gap is xs;
                                                        // +xs = sm between
                                                        // the caption and
                                                        // the note.
                                                        marginTop: spacing.xs,
                                                    },
                                                ]}
                                            >
                                                {watchedParts.note}
                                            </Text>
                                        ) : null}
                                        {watchedParts.ratingLine !== null ? (
                                            <Text
                                                style={[
                                                    typography.body,
                                                    {
                                                        color: specialColor,
                                                        marginTop: spacing.xs,
                                                    },
                                                ]}
                                            >
                                                {watchedParts.ratingLine}
                                            </Text>
                                        ) : null}
                                    </>
                                ) : (
                                    <Text
                                        style={[
                                            typography.body,
                                            { color: bodyColor },
                                        ]}
                                    >
                                        {c.body}
                                    </Text>
                                )}
                                {/* Reaction badge overlapping the bubble's
                                    INNER top corner (facing the screen's
                                    centre). Shared pill (ReactionBadge) —
                                    only the horizontal anchoring is ours. A
                                    1:1 thread holds at most one reaction per
                                    party, so the badge renders one — rarely
                                    two — emojis. */}
                                <ReactionBadge
                                    reactions={cReactionList}
                                    palette={palette}
                                    style={
                                        isMine
                                            ? styles.badgeMine
                                            : styles.badgeTheirs
                                    }
                                />
                            </Pressable>
                        </View>
                        {expandedTimeId === c.id ? (
                            <Text
                                style={[
                                    typography.caption,
                                    styles.expandedTime,
                                    isMine
                                        ? styles.expandedTimeMine
                                        : styles.expandedTimeTheirs,
                                    { color: palette.textMuted },
                                ]}
                            >
                                {formatMessageTime(c.createdAt)}
                            </Text>
                        ) : null}
                    </Fragment>
                );
            })}
        </View>
    );
}

const styles = StyleSheet.create({
    commentsList: {
        // NO uniform gap — vertical rhythm is per-row (see rowMarginTop):
        // tight within a same-sender run, wider between senders, wider
        // still above a bubble carrying a reaction badge.
        marginTop: spacing.xl,
    },
    timeSeparator: {
        alignSelf: 'center',
        marginTop: spacing.base,
        marginBottom: spacing.xs,
    },
    bubbleRow: {
        flexDirection: 'row',
        // marginTop applied per-row (clustering + badge headroom).
        // The reaction badge overhangs the bubble (and the row's top edge);
        // explicit visible overflow so no ancestor clips it — Android in
        // particular clips children more eagerly than iOS.
        overflow: 'visible',
    },
    rowMine: {
        justifyContent: 'flex-end',
    },
    rowTheirs: {
        justifyContent: 'flex-start',
    },
    bubble: {
        maxWidth: '78%',
        paddingHorizontal: spacing.base,
        paddingVertical: spacing.sm + 2,
        borderRadius: radius.lg,
        gap: spacing.xs,
        // The reaction badge hangs past the top corner.
        overflow: 'visible',
    },
    bubbleMine: {
        // Tighter corner on the anchor (bottom-trailing) side — the
        // screenshot's bubble shape.
        borderBottomRightRadius: radius.sm / 2,
    },
    bubbleTheirs: {
        borderBottomLeftRadius: radius.sm / 2,
    },
    // Inner-corner anchoring: the badge hangs off the bubble's top corner
    // on the side facing the screen's CENTRE (own bubbles sit right →
    // badge off the top-left; theirs → off the top-right). -12 pushes it
    // further centre-ward than the original -8 so most of the badge
    // (~26pt wide for one emoji) floats in the open space beside the
    // bubble, intruding only ~14pt — inside the bubble's 16pt text inset,
    // so it clears the word beneath. The centre side has the whole
    // conversation width to spare, so no edge/clipping risk.
    badgeMine: {
        left: -12,
    },
    badgeTheirs: {
        right: -12,
    },
    expandedTime: {
        marginTop: 2,
    },
    expandedTimeMine: {
        alignSelf: 'flex-end',
        marginRight: spacing.sm,
    },
    expandedTimeTheirs: {
        alignSelf: 'flex-start',
        marginLeft: spacing.sm,
    },
});
