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

import type { Database } from './database.types';
import { env } from './env';

const supabase = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: {
        storage: AsyncStorage,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
    },
});

export default supabase;
