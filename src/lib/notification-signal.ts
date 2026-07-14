/**
 * Cross-tree signal for notification-row changes.
 *
 * UnreadCountProvider owns the ONE realtime channel (its notifications
 * binding). It publishes each change here; consumers subscribe. The inbox is
 * the consumer — and it's a ROOT route, mounted OUTSIDE (tabs)/_layout where
 * the provider lives, so it isn't a descendant and can't read the provider's
 * React context. This module-level registry bridges that gap without a second
 * channel: the provider stays the sole channel owner and the sole emitter; the
 * inbox just listens. Same one-channel, one-signal design as a context fan-out,
 * decoupled from tree ancestry.
 *
 * The count still comes only from the provider's RPC — this signal carries
 * row-change descriptors, never a count.
 */

export interface NotificationChange {
    eventType: 'INSERT' | 'UPDATE' | 'DELETE';
    // notifications.read_at on the NEW row (null on DELETE, where there is no
    // new row). A re-surfaced overlap sets this back to null.
    newReadAt: string | null;
    // notifications.payload before / after. Both present on UPDATE under
    // REPLICA IDENTITY FULL; null where absent (INSERT has no old, DELETE no
    // new). The inbox compares them to tell an overlap update (payload changed)
    // from the read_at sweep (payload identical).
    oldPayload: Record<string, unknown> | null;
    newPayload: Record<string, unknown> | null;
}

const listeners = new Set<(change: NotificationChange) => void>();

// Called by UnreadCountProvider's notifications binding, once per event.
export function emitNotificationChange(change: NotificationChange): void {
    listeners.forEach((cb) => cb(change));
}

// Called by consumers (the inbox). Returns an unsubscribe.
export function subscribeNotificationChange(
    cb: (change: NotificationChange) => void,
): () => void {
    listeners.add(cb);
    return () => {
        listeners.delete(cb);
    };
}
