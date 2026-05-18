import type { Session } from '@supabase/supabase-js';
import { useEffect, useState } from 'react';

import supabase from '@/lib/supabase';

/**
 * Tracks the current Supabase auth session. Returns one of two shapes:
 *   - { status: 'loading' }  — initial getSession() in-flight
 *   - { status: 'ready', session }  — session resolved (may be null = signed out)
 *
 * Subscribes to onAuthStateChange so the hook re-renders consumers on
 * sign-in, sign-out, and token refresh.
 */
export type SessionState =
    | { status: 'loading'; session: null }
    | { status: 'ready'; session: Session | null };

export function useSession(): SessionState {
    const [state, setState] = useState<SessionState>({ status: 'loading', session: null });

    useEffect(() => {
        let active = true;

        supabase.auth.getSession().then(({ data }) => {
            if (active) setState({ status: 'ready', session: data.session });
        });

        const { data } = supabase.auth.onAuthStateChange((_event, session) => {
            setState({ status: 'ready', session });
        });

        return () => {
            active = false;
            data.subscription.unsubscribe();
        };
    }, []);

    return state;
}
