import { useCallback, useState } from 'react';
import { Alert } from 'react-native';

import supabase from '@/lib/supabase';

interface RequestTarget {
    userId: string;
    /** Display/first name, for the sheet prompt + success copy. */
    name: string;
}

/**
 * Shared "request a recommendation" flow, surfaced from both the friend
 * profile and the friends-list rows. Owns the target + busy state and the
 * RPC call so both entry points behave identically; each screen just calls
 * `open(...)` and renders a <RequestRecSheet> wired to the returned props.
 *
 * v1 is untied: the RPC inserts a single `rec_requested` notification (no
 * request table, no status). The friend responds by sending a normal rec.
 */
export function useRequestRec() {
    const [target, setTarget] = useState<RequestTarget | null>(null);
    const [busy, setBusy] = useState(false);

    const open = useCallback((userId: string, name: string) => {
        setTarget({ userId, name });
    }, []);

    const close = useCallback(() => {
        // Block dismiss mid-send so the spinner can't be orphaned.
        if (!busy) setTarget(null);
    }, [busy]);

    const send = useCallback(
        async (note: string) => {
            if (!target) return;
            setBusy(true);
            try {
                const { error } = await supabase.rpc('request_recommendation', {
                    to_user_id: target.userId,
                    note: note.length > 0 ? note : undefined,
                });
                if (error) throw error;
                setTarget(null);
                Alert.alert(
                    'Request sent',
                    `We let ${target.name} know you'd like a recommendation.`,
                );
            } catch (err) {
                console.error('request recommendation failed:', err);
                Alert.alert('Could not send', 'Please try again.');
            } finally {
                setBusy(false);
            }
        },
        [target],
    );

    return { target, busy, open, close, send };
}
