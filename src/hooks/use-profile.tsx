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
    bio: string | null;
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
        // Bounded retries for an EMPTY-but-valid profile result (a transient
        // token/RLS race on cold start) before concluding "no profile". Keeps a
        // genuinely new signup resolving to onboarding once the retries are
        // exhausted, while stopping an existing user from being surfaced as
        // ready+null (which bounces them through the onboarding flash).
        const EMPTY_PROFILE_MAX_ATTEMPTS = 4;

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
                    .select('id, handle, display_name, avatar_url, bio, onboarded')
                    .eq('id', userId)
                    .maybeSingle();
                if (generationRef.current !== gen) return;
                if (error) throw error;

                if (!data) {
                    // No profile row for this session's user. Two
                    // possibilities:
                    //   (a) freshly signed-up and the on_signup
                    //       trigger hasn't materialised the row yet
                    //       (rare race, since the trigger runs in
                    //       the same transaction as the auth.users
                    //       insert);
                    //   (b) the user was deleted server-side (e.g.
                    //       from the Supabase dashboard during dev),
                    //       which cascade-deleted the profile row,
                    //       but the cached JWT is still locally
                    //       valid and getSession() returns it on
                    //       cold start.
                    // Distinguish by calling auth.getUser(): in case
                    // (b) the server confirms the user is gone and
                    // returns 401/403/404, so we sign out before
                    // routing the user into a doomed onboarding
                    // flow. Network errors fall through to the
                    // "no profile, proceed as not-onboarded" path
                    // so transient failures don't spuriously kick
                    // people out.
                    const { error: userError } = await supabase.auth.getUser();
                    if (generationRef.current !== gen) return;
                    if (userError) {
                        const status =
                            'status' in userError
                                ? (userError as { status?: number }).status
                                : undefined;
                        if (status === 401 || status === 403 || status === 404) {
                            console.warn(
                                'useProfile: session JWT references a deleted user, signing out',
                            );
                            await supabase.auth.signOut();
                            return;
                        }
                    }
                    // Valid (non-deleted) user but the profiles query came back
                    // empty. For an EXISTING user this is a transient cold-start
                    // race (auth token / RLS not settled, or refresh ordering) —
                    // surfacing ready+null here is what bounced onboarded users
                    // through the onboarding flash. Retry a bounded number of
                    // times; the row loads on a later attempt. A genuinely new
                    // signup stays empty across all attempts and then resolves
                    // to ready+null → onboarding, so the new-user path is kept.
                    if (attempt < EMPTY_PROFILE_MAX_ATTEMPTS) {
                        const delayMs = Math.min(300 * attempt, 1200);
                        await new Promise((resolve) => setTimeout(resolve, delayMs));
                        continue;
                    }
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
                        bio: data.bio,
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
