/**
 * Validated environment variables.
 *
 * Expo inlines `process.env.EXPO_PUBLIC_*` references at build time, so they
 * must be accessed via dot notation (not bracket lookup). We read each one
 * here, fail fast with a clear error if anything is missing, and re-export
 * the narrowed values as a single typed object. Import from this module
 * instead of touching `process.env` directly.
 */

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    const missing = [
        !SUPABASE_URL ? 'EXPO_PUBLIC_SUPABASE_URL' : null,
        !SUPABASE_ANON_KEY ? 'EXPO_PUBLIC_SUPABASE_ANON_KEY' : null,
    ]
        .filter((name): name is string => name !== null)
        .join(', ');
    throw new Error(
        `Missing required environment variable(s): ${missing}. ` +
            `Add them to .env.local at the project root and restart the dev server with \`npx expo start --clear\`.`,
    );
}

export const env = {
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
} as const;
