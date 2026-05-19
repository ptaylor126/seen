import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import supabase from '@/lib/supabase';

/**
 * Unread/unactioned count for the notifications bell badge.
 *
 * Sums three sources:
 *   1. Pending incoming recommendations (recommendations.status = 'pending', to_user_id = me)
 *   2. Pending friend requests (friend_requests where to_user_id = me)
 *   3. Unread `rec_watched` / `friend_accepted` notifications
 *      (`rec_received` and `friend_request` notification kinds are
 *       intentionally excluded — they'd double-count with sources 1+2.)
 *
 * Refetches on screen focus via `useFocusEffect`. After the inbox marks
 * notifications read, navigating back to a tab will refocus and recount,
 * so the badge updates without manual coordination.
 */
export function useUnreadCount(): { count: number; refresh: () => Promise<void> } {
    const [count, setCount] = useState(0);

    const refresh = useCallback(async () => {
        try {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            const userId = session?.user.id;
            if (!userId) {
                setCount(0);
                return;
            }

            const [recsResult, requestsResult, notificationsResult] = await Promise.all([
                supabase
                    .from('recommendations')
                    .select('id', { count: 'exact', head: true })
                    .eq('to_user_id', userId)
                    .eq('status', 'pending'),
                supabase
                    .from('friend_requests')
                    .select('id', { count: 'exact', head: true })
                    .eq('to_user_id', userId),
                supabase
                    .from('notifications')
                    .select('id', { count: 'exact', head: true })
                    .eq('user_id', userId)
                    .in('kind', ['rec_watched', 'friend_accepted'])
                    .is('read_at', null),
            ]);

            if (recsResult.error) throw recsResult.error;
            if (requestsResult.error) throw requestsResult.error;
            if (notificationsResult.error) throw notificationsResult.error;

            setCount(
                (recsResult.count ?? 0) +
                    (requestsResult.count ?? 0) +
                    (notificationsResult.count ?? 0),
            );
        } catch (err) {
            console.error('unread count fetch failed:', err);
            // Don't surface to UI — a stale badge is better than a crash.
        }
    }, []);

    useFocusEffect(
        useCallback(() => {
            refresh();
        }, [refresh]),
    );

    return { count, refresh };
}
