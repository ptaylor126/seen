import { Redirect } from 'expo-router';

// General fallback for any URL the router can't match (invite URLs never
// reach here — +native-intent rewrites them to '/' first; this catches
// everything else: stale deep links, malformed pushes). Redirecting to
// (tabs) instead of rendering expo-router's built-in Unmatched Route
// screen matters beyond cosmetics: the unmatched screen's segments are
// neither (tabs) nor (auth) nor (onboarding), which wedges the launch
// overlay's `ready` condition on cold starts until its 8s safety
// timeout, and the root routing effect only ever redirects OUT of
// (auth)/(onboarding), so nothing else would recover.
export default function NotFound() {
    return <Redirect href="/(tabs)" />;
}
