import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useRef,
    useState,
    type ReactNode,
} from 'react';

import supabase from '@/lib/supabase';

export interface Profile {
    id: string;
    handle: string;
    displayName: string;
    avatarUrl: string | null;
    onboarded: boolean;
}

interface ProfileContextValue {
    status: 'loading' | 'ready';
    profile: Profile | null;
    refresh: () => Promise<void>;
}

const ProfileContext = createContext<ProfileContextValue | null>(null);

// Provider wraps the app at the root layout so any descendant can call
// useProfile() and share the same state — important for the onboarding
// flow, where the screen-level completion handler updates the DB and
// calls refresh(), causing the root layout's routing effect to re-run
// with onboarded: true and redirect into /(tabs) without a race.
//
// Errors during fetch are intentionally suppressed at the state level:
// instead of transitioning to an `error` status (which would leave the
// user staring at a non-routed loading overlay), refresh() retries
// indefinitely with capped exponential backoff. Transient network
// blips self-heal; persistent failure keeps the loading spinner up
// rather than dumping the user into a broken state. A generation
// counter cancels the retry loop when refresh() is called again or
// when the user signs out, so superseded retries don't overwrite the
// latest state.
export function ProfileProvider({ children }: { children: ReactNode }) {
    const [state, setState] = useState<{
        status: 'loading' | 'ready';
        profile: Profile | null;
    }>({
        status: 'loading',
        profile: null,
    });

    const generationRef = useRef(0);

    const refresh = useCallback(async () => {
        const gen = ++generationRef.current;
        let attempt = 0;

        // Loop until: (a) success, (b) we're superseded by a newer
        // refresh() call, or (c) the user signs out (detected via the
        // no-session branch). Stays in 'loading' state during the
        // retry chain — the loading overlay in the root layout is a
        // fine "we're still trying" indicator.
        while (generationRef.current === gen) {
            attempt += 1;
            try {
                const {
                    data: { session },
                } = await supabase.auth.getSession();
                if (generationRef.current !== gen) return;

                const userId = session?.user.id;
                if (!userId) {
                    setState({ status: 'ready', profile: null });
                    return;
                }

                const { data, error } = await supabase
                    .from('profiles')
                    .select('id, handle, display_name, avatar_url, onboarded')
                    .eq('id', userId)
                    .maybeSingle();
                if (generationRef.current !== gen) return;
                if (error) throw error;

                if (!data) {
                    // Trigger normally creates a profile row on signup;
                    // missing row here is unusual but recoverable —
                    // treat as not-onboarded so the user can complete
                    // the flow.
                    setState({ status: 'ready', profile: null });
                    return;
                }

                setState({
                    status: 'ready',
                    profile: {
                        id: data.id,
                        handle: data.handle,
                        displayName: data.display_name,
                        avatarUrl: data.avatar_url,
                        onboarded: data.onboarded,
                    },
                });
                return;
            } catch (err) {
                console.warn(
                    `useProfile: refresh attempt ${attempt} failed, retrying`,
                    err,
                );
                const delayMs = Math.min(
                    1500 * Math.pow(2, attempt - 1),
                    30000,
                );
                await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
        }
    }, []);

    useEffect(() => {
        let active = true;
        (async () => {
            await refresh();
            if (!active) return;
        })();

        // Refetch on sign-in, clear on sign-out. SIGNED_IN fires on the
        // initial load too, so the first refetch is redundant but cheap.
        const { data } = supabase.auth.onAuthStateChange((event) => {
            if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
                void refresh();
            } else if (event === 'SIGNED_OUT') {
                // Bump the generation so any in-flight retry bails.
                generationRef.current += 1;
                setState({ status: 'ready', profile: null });
            }
        });

        return () => {
            active = false;
            data.subscription.unsubscribe();
        };
    }, [refresh]);

    return (
        <ProfileContext.Provider
            value={{
                status: state.status,
                profile: state.profile,
                refresh,
            }}
        >
            {children}
        </ProfileContext.Provider>
    );
}

export function useProfile(): ProfileContextValue {
    const ctx = useContext(ProfileContext);
    if (!ctx) {
        throw new Error('useProfile must be used within a ProfileProvider');
    }
    return ctx;
}
