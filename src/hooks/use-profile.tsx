import {
    createContext,
    useCallback,
    useContext,
    useEffect,
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
    status: 'loading' | 'ready' | 'error';
    profile: Profile | null;
    error: string | null;
    refresh: () => Promise<void>;
}

const ProfileContext = createContext<ProfileContextValue | null>(null);

// Provider wraps the app at the root layout so any descendant can call
// useProfile() and share the same state — important for the onboarding
// flow, where the screen-level completion handler updates the DB and
// calls refresh(), causing the root layout's routing effect to re-run
// with onboarded: true and redirect into /(tabs) without a race.
export function ProfileProvider({ children }: { children: ReactNode }) {
    const [state, setState] = useState<{
        status: 'loading' | 'ready' | 'error';
        profile: Profile | null;
        error: string | null;
    }>({
        status: 'loading',
        profile: null,
        error: null,
    });

    const refresh = useCallback(async () => {
        try {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            const userId = session?.user.id;
            if (!userId) {
                setState({ status: 'ready', profile: null, error: null });
                return;
            }
            const { data, error } = await supabase
                .from('profiles')
                .select('id, handle, display_name, avatar_url, onboarded')
                .eq('id', userId)
                .maybeSingle();
            if (error) throw error;
            if (!data) {
                // Trigger normally creates a profile row on signup;
                // missing row here is unusual but recoverable — treat
                // as not-onboarded so the user can complete the flow.
                setState({ status: 'ready', profile: null, error: null });
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
                error: null,
            });
        } catch (err) {
            console.error('useProfile: refresh failed', err);
            setState({
                status: 'error',
                profile: null,
                error: err instanceof Error ? err.message : 'Failed to load profile',
            });
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
                setState({ status: 'ready', profile: null, error: null });
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
                error: state.error,
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
