// Shared types + constants for the thread UI (comment list, composer,
// reactions, long-press menu) extracted from rec/[recId].tsx. Pure move —
// the rec screen imports these back; no semantics changed.

// Locked emoji set — must match the CHECK constraint on
// recommendation_reactions.emoji. Widening is a one-line migration
// PLUS adding the new emoji to this array. Order is the picker order.
export const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '👀'] as const;
export type ReactionEmoji = (typeof REACTION_EMOJIS)[number];

export function isReactionEmoji(value: string): value is ReactionEmoji {
    return (REACTION_EMOJIS as readonly string[]).includes(value);
}

export const COMMENT_MAX_CHARS = 500;

export interface PartyProfile {
    userId: string;
    displayName: string;
    avatarUrl: string | null;
}

export interface ReactionRow {
    userId: string;
    emoji: ReactionEmoji;
    // Present on rec-level reactions (drives the last-seen identity in the
    // rec screen). Omitted for comment reactions, which don't animate on
    // this marker.
    createdAt?: string;
}

export interface CommentRow {
    id: string;
    userId: string | null;
    author: PartyProfile | null; // null = author was deleted (user_id SET NULL)
    body: string;
    createdAt: string;
    // Originated from the post-watched sheet (rating comment) → shows a quiet
    // "watched" status under the name. False for ordinary typed comments.
    fromWatched: boolean;
}

// Payload for the long-press comment menu, anchored at the touch point of
// the comment the user pressed. `anchorY` is from the long-press event's
// nativeEvent.pageY (screen Y); `isOwn` controls whether the actions menu
// appears below the emoji row.
export interface CommentMenuTarget {
    commentId: string;
    anchorY: number;
    isOwn: boolean;
    // Comment author's user id — used to stamp a report's reported_user_id
    // for someone else's comment. null if the author was deleted.
    authorId: string | null;
}

export function relativeTimestamp(iso: string): string {
    const date = new Date(iso);
    const diffMs = Date.now() - date.getTime();
    const diffMinutes = diffMs / (1000 * 60);
    const diffHours = diffMinutes / 60;
    const diffDays = diffHours / 24;
    if (diffMinutes < 1) return 'just now';
    if (diffMinutes < 60) return `${Math.floor(diffMinutes)}m`;
    if (diffHours < 24) return `${Math.floor(diffHours)}h`;
    if (diffDays < 7) return `${Math.floor(diffDays)}d`;
    return date.toLocaleDateString();
}
