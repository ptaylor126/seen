import { MotiView } from 'moti';
import {
    Pressable,
    StyleSheet,
    Text,
    useColorScheme,
    View,
} from 'react-native';

import { Avatar } from '@/components/avatar';
import {
    type CommentMenuTarget,
    type CommentRow,
    type ReactionRow,
    relativeTimestamp,
} from '@/components/thread/shared';
import { UserLink } from '@/components/user-link';
import { goToProfile } from '@/lib/profile-nav';
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

// The flat chronological comment list of a thread. Extracted verbatim from
// rec/[recId].tsx — no label; the composer placeholder carries the empty
// state; an empty list renders nothing (just the container).
export function ThreadCommentList({
    comments,
    myUserId,
    commentReactions,
    onLongPressComment,
}: {
    comments: CommentRow[];
    myUserId: string | null;
    // comment_id → reactions on that comment (O(1) lookups in the render path).
    commentReactions: Map<string, ReactionRow[]>;
    // Long-press → the screen opens the comment menu popover at this anchor.
    onLongPressComment: (target: CommentMenuTarget) => void;
}) {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);

    return (
        <View style={styles.commentsList}>
            {comments.map((c) => {
                const isMine = c.userId === myUserId;
                const authorName = c.author?.displayName ?? 'Deleted user';
                // Full reaction list for this comment —
                // rendered as a persistent badge under the
                // body, one chip per (user, emoji). Tap
                // semantics live in the long-press popover;
                // the badge is display-only.
                const cReactionList = commentReactions.get(c.id) ?? [];
                // Watched-sheet comments carry the rating as a
                // trailing "Gave it ★★★★" line — split it out
                // so it renders as its own accent line (tight
                // gap) rather than a \n\n blank line in the body.
                const watchedParts = c.fromWatched
                    ? splitWatchedBody(c.body)
                    : null;
                // Rating-only watched comment (no note) → the
                // "watched" caption and the rating line would be
                // two near-identical accent lines, so collapse
                // to a single "watched · ★★★★" (glyphs only,
                // dropping the rating lead-in).
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
                return (
                    <Pressable
                        key={c.id}
                        onLongPress={(e) =>
                            onLongPressComment({
                                commentId: c.id,
                                anchorY: e.nativeEvent.pageY,
                                isOwn: isMine,
                                authorId: c.userId,
                            })
                        }
                        style={styles.commentRow}
                    >
                        <UserLink
                            userId={c.userId}
                            disabled={isMine || !c.userId}
                            hitSlop={8}
                            accessibilityLabel={`View ${authorName}'s profile`}
                        >
                            <Avatar
                                avatarUrl={c.author?.avatarUrl ?? null}
                                displayName={authorName}
                                seedId={c.userId ?? `deleted:${c.id}`}
                                size={28}
                            />
                        </UserLink>
                        <View style={styles.commentText}>
                            <View style={styles.commentMeta}>
                                <Text
                                    style={[
                                        typography.caption,
                                        {
                                            color: palette.text,
                                            fontWeight: '600',
                                        },
                                    ]}
                                    onPress={
                                        isMine || !c.userId
                                            ? undefined
                                            : () =>
                                                  goToProfile({
                                                      userId: c.userId,
                                                  })
                                    }
                                >
                                    {isMine ? 'You' : authorName}
                                </Text>
                                <Text
                                    style={[
                                        typography.caption,
                                        {
                                            color: palette.textMuted,
                                        },
                                    ]}
                                >
                                    {relativeTimestamp(c.createdAt)}
                                </Text>
                            </View>
                            {/* Quiet "watched" status for
                                post-watched-sheet comments — a
                                plum accent line under the name,
                                not a badge. Hidden in the no-note
                                case, where it merges into the
                                single collapsed line below. */}
                            {c.fromWatched && !collapsedWatchedStars ? (
                                <Text
                                    style={[
                                        typography.caption,
                                        { color: palette.accent },
                                    ]}
                                >
                                    watched
                                </Text>
                            ) : null}
                            {collapsedWatchedStars ? (
                                <Text
                                    style={[
                                        typography.caption,
                                        { color: palette.accent },
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
                                                    color: palette.text,
                                                    // Container
                                                    // gap is xs;
                                                    // +xs = sm
                                                    // between the
                                                    // "watched"
                                                    // caption and
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
                                                    color: palette.accent,
                                                    // Container
                                                    // gap is xs;
                                                    // +xs = sm
                                                    // between note
                                                    // and rating.
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
                                        { color: palette.text },
                                    ]}
                                >
                                    {c.body}
                                </Text>
                            )}
                            {cReactionList.length > 0 ? (
                                <View style={styles.commentReactionsBadge}>
                                    {cReactionList.map((r) => {
                                        const mine = r.userId === myUserId;
                                        return (
                                            <MotiView
                                                key={r.userId}
                                                // Spring pop as
                                                // a reaction
                                                // lands (yours
                                                // on tap, or a
                                                // new one via
                                                // realtime —
                                                // stable key so
                                                // only new
                                                // chips pop).
                                                from={{
                                                    scale: 0,
                                                }}
                                                animate={{
                                                    scale: 1,
                                                }}
                                                transition={{
                                                    type: 'spring',
                                                    damping: 11,
                                                    stiffness: 260,
                                                }}
                                                style={[
                                                    styles.commentReactionChip,
                                                    {
                                                        backgroundColor: mine
                                                            ? palette.accent
                                                            : palette.surfaceAlt,
                                                    },
                                                ]}
                                            >
                                                <Text
                                                    style={
                                                        styles.commentReactionChipEmoji
                                                    }
                                                >
                                                    {r.emoji}
                                                </Text>
                                            </MotiView>
                                        );
                                    })}
                                </View>
                            ) : null}
                        </View>
                    </Pressable>
                );
            })}
        </View>
    );
}

const styles = StyleSheet.create({
    commentsList: {
        gap: spacing.md,
        // Replaces the spacing the removed "Comments" label used to give.
        marginTop: spacing.xl,
    },
    commentRow: {
        flexDirection: 'row',
        gap: spacing.sm,
        alignItems: 'flex-start',
    },
    commentText: {
        flex: 1,
        gap: spacing.xs,
    },
    commentMeta: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
    },
    // Resting-state badge under each comment body. `commentText` has
    // gap: spacing.xs between siblings, so no marginTop here. flexWrap
    // so a future widening of the emoji set or multi-party threads
    // can grow vertically without overflowing the row.
    commentReactionsBadge: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.xs,
    },
    commentReactionChip: {
        paddingHorizontal: spacing.xs,
        paddingVertical: 2,
        borderRadius: radius.full,
        minHeight: 22,
        minWidth: 28,
        alignItems: 'center',
        justifyContent: 'center',
    },
    commentReactionChipEmoji: {
        fontSize: 14,
        lineHeight: 16,
    },
});
