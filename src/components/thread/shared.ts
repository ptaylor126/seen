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

// Minimum gap between consecutive messages before the thread renders a
// centered time separator between them (iMessage-style). Messages closer
// together read as one exchange and get no marker. Three hours: title
// conversations here are slow-cadence (spanning evenings/days), so an
// evening's exchange reads as one block and a new day/session always gets
// its marker — 30 minutes produced near-hourly noise.
export const TIME_SEPARATOR_GAP_MS = 3 * 60 * 60 * 1000;

// Contextual absolute time for thread separators and the tap-to-reveal
// exact send time: "Today 2:47 PM", "Yesterday 2:47 PM", a weekday within
// the last six days ("Tuesday 2:47 PM"), else a date ("Jul 3, 2:47 PM").
export function formatMessageTime(iso: string): string {
    const date = new Date(iso);
    const now = new Date();
    const time = date.toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit',
    });
    const startOfDay = (d: Date) =>
        new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const dayDiff = Math.round(
        (startOfDay(now) - startOfDay(date)) / (24 * 60 * 60 * 1000),
    );
    if (dayDiff <= 0) return `Today ${time}`;
    if (dayDiff === 1) return `Yesterday ${time}`;
    if (dayDiff < 7) {
        return `${date.toLocaleDateString([], { weekday: 'long' })} ${time}`;
    }
    return `${date.toLocaleDateString([], {
        month: 'short',
        day: 'numeric',
        ...(date.getFullYear() !== now.getFullYear()
            ? { year: 'numeric' }
            : {}),
    })}, ${time}`;
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
