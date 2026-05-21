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
import { LogBox } from 'react-native';

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

export default supabase;
