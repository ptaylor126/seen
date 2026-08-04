/**
 * Supabase client singleton.
 *
 * This is the ONLY place in the app that should call `createClient`. Import
 * the default export from here for any auth, database, realtime, or RPC
 * work. The client is parameterised by the `Database` type generated from
 * the live schema (via `npx supabase gen types typescript --linked`), so
 * `.from(...)`, `.rpc(...)`, and policy-gated queries are statically typed
 * end-to-end.
 *
 * The `react-native-url-polyfill` import must come before `@supabase/supabase-js`
 * — Supabase's auth/realtime URL parsing relies on a fully spec-compliant
 * `URL` global, which React Native does not provide out of the box.
 */
import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import { AppState, LogBox } from 'react-native';

import type { Database } from './database.types';
import { env } from './env';

// supabase-js logs background refresh failures as console.error, which
// RN's LogBox surfaces as a red dev toast. The cases we see here are
// recoverable — supabase-js clears the bad session and emits SIGNED_OUT,
// our root layout routes the user to /(auth)/sign-in. The visible
// error is dev noise; ignore it so it doesn't shout over the actual UI.
LogBox.ignoreLogs([
    'Invalid Refresh Token',
    'Refresh Token Not Found',
    'AuthApiError',
]);

const supabase = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: {
        storage: AsyncStorage,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
    },
});

// Token refresh ↔ app lifecycle (the standard supabase-js RN wiring).
// RN timers don't fire in the background, so the auto-refresh loop that
// autoRefreshToken starts silently stalls while the app is backgrounded —
// come back hours later and the access token can be expired until the
// next tick happens to run, surfacing as mysterious 401s / hung queries
// right after foregrounding. startAutoRefresh() on 'active' runs a
// refresh check IMMEDIATELY (not just re-arming the timer), so a stale
// session is healed at the moment of return; stopAutoRefresh() on
// background parks the loop instead of leaving a timer that can't fire.
// Module scope, alongside the singleton: registered exactly once for the
// app's lifetime, never removed — this listener should live as long as
// the client does.
AppState.addEventListener('change', (state) => {
    if (state === 'active') {
        supabase.auth.startAutoRefresh();
    } else {
        supabase.auth.stopAutoRefresh();
    }
});

export default supabase;
