// delete-account — permanently deletes the caller's account (Apple guideline
// 5.1.1(v)). Immediate and irreversible; there is no soft-delete.
//
// Auth model: the uid is taken from the caller's VERIFIED JWT only, never
// from the request body — so this function can only ever delete the
// caller's own account. Same JWT pattern as submit-feedback.
//
// Order (strictly sequential; any failure returns an error and does NOT
// proceed to the next step, so a partial run leaves the account intact and
// retryable):
//   1. Remove the caller's Storage objects under avatars/{uid}/ and
//      feedback/{uid}/ (idempotent — missing objects are a no-op).
//   2. delete_account_data(uid) — the transactional DB deletes (service role).
//   3. auth.admin.deleteUser(uid) — LAST. Auth deletion last so an earlier
//      failure leaves the auth user (and thus the account) in place.
//
// Storage and auth.users do not cascade from each other, which is why both
// are handled here explicitly around the DB RPC.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers':
        'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Buckets holding user-owned objects under a `{uid}/` folder prefix.
const USER_STORAGE_BUCKETS = ['avatars', 'feedback'] as const;
// Storage list page size. We drain each folder in pages so a user with many
// objects (e.g. accumulated avatar revisions + feedback screenshots) is
// fully cleared, not just the first page.
const LIST_PAGE_SIZE = 100;

function jsonResponse(body: unknown, status: number): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
}

// Remove every object under `{uid}/` in `bucket`. Idempotent: an empty/
// missing folder removes nothing and returns normally. Throws on a genuine
// list/remove error so the caller can abort before the destructive DB step.
async function clearUserFolder(
    serviceClient: SupabaseClient,
    bucket: string,
    uid: string,
): Promise<void> {
    // Drain in pages. After each remove the objects are gone, so we keep
    // listing from offset 0 until a page comes back empty.
    for (;;) {
        const { data: entries, error: listError } = await serviceClient.storage
            .from(bucket)
            .list(uid, { limit: LIST_PAGE_SIZE });
        if (listError) {
            throw new Error(
                `storage list failed (${bucket}/${uid}): ${listError.message}`,
            );
        }
        if (!entries || entries.length === 0) {
            return; // folder empty / absent — done
        }
        const paths = entries.map((e) => `${uid}/${e.name}`);
        const { error: removeError } = await serviceClient.storage
            .from(bucket)
            .remove(paths);
        if (removeError) {
            throw new Error(
                `storage remove failed (${bucket}/${uid}): ${removeError.message}`,
            );
        }
        // Fewer than a full page means there's nothing left to fetch.
        if (entries.length < LIST_PAGE_SIZE) {
            return;
        }
    }
}

Deno.serve(async (req: Request) => {
    try {
        if (req.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders });
        }
        if (req.method !== 'POST') {
            return jsonResponse({ error: 'method_not_allowed' }, 405);
        }

        // ---- Authenticate. uid comes from the verified token ONLY.
        const authHeader = req.headers.get('Authorization');
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return jsonResponse({ error: 'unauthorized' }, 401);
        }
        const jwt = authHeader.slice('Bearer '.length);

        const supabaseUrl = Deno.env.get('SUPABASE_URL');
        const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
        const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
        if (!supabaseUrl || !anonKey || !serviceRoleKey) {
            return jsonResponse({ error: 'misconfigured' }, 500);
        }

        const userClient = createClient(supabaseUrl, anonKey, {
            global: { headers: { Authorization: authHeader } },
            auth: { persistSession: false },
        });
        const {
            data: { user },
            error: authError,
        } = await userClient.auth.getUser(jwt);
        if (authError || !user) {
            return jsonResponse({ error: 'unauthorized' }, 401);
        }
        const uid = user.id;

        // Service-role client for the privileged deletes. The request body
        // is intentionally never read — uid is the only thing we act on.
        const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
            auth: { persistSession: false },
        });

        // ---- 1. Storage (before any DB delete). Abort on real failure.
        try {
            for (const bucket of USER_STORAGE_BUCKETS) {
                await clearUserFolder(serviceClient, bucket, uid);
            }
        } catch (storageErr) {
            const detail =
                storageErr instanceof Error
                    ? storageErr.message
                    : String(storageErr);
            console.error('delete-account storage step failed:', detail);
            return jsonResponse({ error: 'storage_failed', detail }, 500);
        }

        // ---- 2. Transactional DB deletes (all-or-nothing, idempotent).
        const { error: rpcError } = await serviceClient.rpc(
            'delete_account_data',
            { p_uid: uid },
        );
        if (rpcError) {
            console.error('delete-account RPC failed:', rpcError.message);
            return jsonResponse(
                { error: 'data_delete_failed', detail: rpcError.message },
                500,
            );
        }

        // ---- 3. Delete the auth user LAST (cascades the rest).
        const { error: deleteUserError } =
            await serviceClient.auth.admin.deleteUser(uid);
        if (deleteUserError) {
            console.error(
                'delete-account auth deletion failed:',
                deleteUserError.message,
            );
            return jsonResponse(
                { error: 'auth_delete_failed', detail: deleteUserError.message },
                500,
            );
        }

        return jsonResponse({ ok: true }, 200);
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.error('delete-account unhandled error:', detail);
        return jsonResponse({ error: 'unhandled', detail }, 500);
    }
});
