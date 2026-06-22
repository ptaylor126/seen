/**
 * Launch readiness signal. The root launch sequence (see LaunchSequence +
 * _layout.tsx) stays up until the destination screen is genuinely ready, not a
 * fixed timer. For signed-out / not-onboarded users that's just auth/profile
 * resolving; for an onboarded user it also needs HOME's initial data — which
 * loads inside the home screen, not the root. Home reports it by calling
 * markDestinationReady() once its first load settles (success OR error).
 */
import { createContext, useContext } from 'react';

interface LaunchReadyContextValue {
    /** Call once the destination screen's initial data has settled. */
    markDestinationReady: () => void;
}

export const LaunchReadyContext = createContext<LaunchReadyContextValue>({
    // No-op default so consumers rendered outside the provider (tests, the
    // dev-logo screen, etc.) don't crash — they just don't gate the launch.
    markDestinationReady: () => {},
});

export function useLaunchReady() {
    return useContext(LaunchReadyContext);
}
