// Push-notification fan-out, triggered by a database webhook on
// public.notifications INSERT events.
//
// Required Supabase dashboard setup (NOT in code):
//   1. Database → Webhooks → Create a new hook
//        Name:    send_push_on_notification_insert
//        Table:   public.notifications
//        Events:  Insert
//        Type:    HTTP Request
//        Method:  POST
//        URL:     https://<project-ref>.supabase.co/functions/v1/send-push-notification
//        Headers: Content-Type: application/json
//                 (Authorization is auto-populated by Supabase with the
//                  project's anon key — sufficient gate at MVP scale;
//                  see "Auth model" note below.)
//   2. Edge Function secrets (Settings → Edge Functions):
//        EXPO_ACCESS_TOKEN     — optional, only if Expo Push Security is enabled
//                                 in EAS Dashboard (otherwise omit).
//        TMDB_ACCESS_TOKEN     — already set for tmdb-proxy; we reuse it.
//        SUPABASE_URL          — populated automatically by Supabase.
//        SUPABASE_SERVICE_ROLE_KEY — populated automatically.
//
// The function reads notification rows, resolves the names/titles that
// belong in a push payload (profiles for sender names, TMDB for titles),
// fans out one push per push_tokens row for the recipient, and reaps
// any tokens that come back DeviceNotRegistered.
//
// Auth model: Supabase's webhook UI auto-fills Authorization with the
// project's anon key. The default Edge Function gateway verifies that
// JWT before our handler runs, so we don't add a second check here. If
// we later need stronger gating (e.g. to lock the function down even
// against leaked anon keys), wire in a WEBHOOK_SECRET shared with the
// webhook config.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

type NotificationKind =
    | 'rec_received'
    | 'rec_watched'
    | 'friend_request'
    | 'friend_accepted';

interface NotificationRow {
    id: string;
    user_id: string;
    kind: NotificationKind;
    payload: Record<string, unknown>;
    read_at: string | null;
    created_at: string;
}

interface WebhookBody {
    type: 'INSERT' | 'UPDATE' | 'DELETE';
    table: string;
    record: NotificationRow | null;
    schema: string;
    old_record: NotificationRow | null;
}

interface PushMessage {
    to: string;
    title: string;
    body?: string;
    data?: Record<string, unknown>;
    sound?: 'default';
}

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(body: unknown, status: number): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
}

Deno.serve(async (req: Request) => {
    // Top-level try/catch so any unhandled exception surfaces as a
    // structured JSON 500 — same pattern as tmdb-proxy.
    try {
        if (req.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders });
        }
        if (req.method !== 'POST') {
            return jsonResponse({ error: 'method_not_allowed' }, 405);
        }

        // ---- 1. Parse + validate the webhook payload.
        //         Auth is handled by the Edge Function gateway (Supabase
        //         webhook → anon-key JWT). See header docs for the
        //         upgrade path if we ever need a stronger check.
        const body = (await req.json()) as WebhookBody;
        if (body.type !== 'INSERT' || body.table !== 'notifications') {
            // Config mistake (webhook firing on wrong events) — log
            // and ack so Supabase doesn't retry forever.
            console.warn('send-push: unexpected webhook payload', {
                type: body.type,
                table: body.table,
            });
            return jsonResponse({ ok: true, ignored: true }, 200);
        }
        const notif = body.record;
        if (!notif || !notif.user_id || !notif.kind) {
            return jsonResponse({ error: 'malformed_record' }, 400);
        }

        // ---- 2. Service-role Supabase client for cross-user reads.
        const supabaseUrl = Deno.env.get('SUPABASE_URL');
        const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
        if (!supabaseUrl || !serviceRoleKey) {
            return jsonResponse({ error: 'misconfigured' }, 500);
        }
        const supabase = createClient(supabaseUrl, serviceRoleKey, {
            auth: { persistSession: false },
        });

        // ---- 3. Fetch the recipient's push tokens.
        const { data: tokens, error: tokensError } = await supabase
            .from('push_tokens')
            .select('expo_push_token')
            .eq('user_id', notif.user_id);
        if (tokensError) {
            console.error('send-push: token lookup failed', tokensError);
            return jsonResponse(
                { error: 'token_lookup_failed', detail: tokensError.message },
                500,
            );
        }
        if (!tokens || tokens.length === 0) {
            // No registered devices — common before the user has
            // accepted permission. Not an error.
            return jsonResponse({ ok: true, no_tokens: true }, 200);
        }

        // ---- 4. Build the push payload (resolves names + titles).
        const message = await buildMessage(supabase, notif);
        if (!message) {
            // Couldn't resolve required data (e.g. sender profile gone)
            // — skip silently, the notification row stays intact for
            // the in-app feed.
            return jsonResponse({ ok: true, message_skipped: true }, 200);
        }

        // ---- 5. Fan out to all device tokens. Expo Push accepts up to
        //         100 messages per request; a single user rarely has
        //         more than a few devices so one request is enough.
        const pushes: PushMessage[] = tokens.map((t) => ({
            ...message,
            to: t.expo_push_token,
            sound: 'default',
        }));

        const expoAccessToken = Deno.env.get('EXPO_ACCESS_TOKEN');
        const sendHeaders: Record<string, string> = {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            // Same defensive header as tmdb-proxy — disables chunked /
            // compressed responses that the Deno runtime can mis-decode
            // (we hit this bug in commit 74a395a).
            'Accept-Encoding': 'identity',
        };
        if (expoAccessToken) {
            sendHeaders.Authorization = `Bearer ${expoAccessToken}`;
        }

        const sendResp = await fetch(EXPO_PUSH_URL, {
            method: 'POST',
            headers: sendHeaders,
            body: JSON.stringify(pushes),
        });
        const sendBody = await sendResp.text();
        if (!sendResp.ok) {
            console.error('send-push: Expo Push API non-2xx', {
                status: sendResp.status,
                body: sendBody.slice(0, 500),
            });
            return jsonResponse(
                { error: 'expo_push_failed', detail: sendBody.slice(0, 500) },
                502,
            );
        }

        // ---- 6. Inspect tickets for DeviceNotRegistered → reap.
        //         Per Expo's docs: that error means the token is
        //         permanently invalid (uninstalled app, etc.) and we
        //         must stop sending to it.
        const stale = collectStaleTokens(pushes, sendBody);
        if (stale.length > 0) {
            const { error: deleteError } = await supabase
                .from('push_tokens')
                .delete()
                .in('expo_push_token', stale);
            if (deleteError) {
                console.warn('send-push: stale token cleanup failed', deleteError);
            }
        }

        return jsonResponse(
            { ok: true, sent: pushes.length, reaped: stale.length },
            200,
        );
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        console.error('send-push: unhandled error', { detail, stack });
        return jsonResponse({ error: 'unhandled', detail }, 500);
    }
});

// Build the Expo Push message for a notification row. Returns null
// when something required can't be resolved — the caller skips sending
// rather than dispatch a half-empty notification.
async function buildMessage(
    supabase: SupabaseClient,
    notif: NotificationRow,
): Promise<{ title: string; body?: string; data: Record<string, unknown> } | null> {
    // Standard data payload routed to all kinds so the client can
    // deep-link to the right screen when the user taps the push.
    const data: Record<string, unknown> = {
        kind: notif.kind,
        notification_id: notif.id,
        ...notif.payload,
    };

    switch (notif.kind) {
        case 'rec_received': {
            const fromUserId = stringField(notif.payload, 'from_user_id');
            const recId = stringField(notif.payload, 'recommendation_id');
            const tmdbId = numberField(notif.payload, 'tmdb_id');
            const mediaType = stringField(notif.payload, 'media_type');
            if (!fromUserId || !recId || tmdbId === null || !mediaType) return null;

            const [senderName, title, note] = await Promise.all([
                fetchDisplayName(supabase, fromUserId),
                fetchTmdbTitle(tmdbId, mediaType),
                fetchRecNote(supabase, recId),
            ]);
            if (!senderName || !title) return null;

            return {
                title: `${senderName} recommended ${title}`,
                body: note ?? undefined,
                data,
            };
        }
        case 'rec_watched': {
            // The recommendation row's `to_user_id` is the watcher
            // (recipient of the original rec). The notification row's
            // `user_id` is the original sender (who we're notifying).
            const watcherId = stringField(notif.payload, 'to_user_id');
            const tmdbId = numberField(notif.payload, 'tmdb_id');
            const mediaType = stringField(notif.payload, 'media_type');
            if (!watcherId || tmdbId === null || !mediaType) return null;

            const [watcherName, title] = await Promise.all([
                fetchDisplayName(supabase, watcherId),
                fetchTmdbTitle(tmdbId, mediaType),
            ]);
            if (!watcherName || !title) return null;

            return {
                title: `${watcherName} watched ${title}`,
                body: 'Your rec hit',
                data,
            };
        }
        case 'friend_request': {
            const fromUserId = stringField(notif.payload, 'from_user_id');
            if (!fromUserId) return null;
            const senderName = await fetchDisplayName(supabase, fromUserId);
            if (!senderName) return null;
            return {
                title: `${senderName} wants to be your friend`,
                data,
            };
        }
        case 'friend_accepted': {
            // payload.from_user_id is the accepter (or invite-link
            // claimer) — see TECHNICAL §1 and the notify migration.
            const accepterId = stringField(notif.payload, 'from_user_id');
            if (!accepterId) return null;
            const accepterName = await fetchDisplayName(supabase, accepterId);
            if (!accepterName) return null;
            return {
                title: `${accepterName} accepted your request`,
                data,
            };
        }
        default:
            return null;
    }
}

function stringField(payload: unknown, key: string): string | null {
    if (!payload || typeof payload !== 'object') return null;
    const value = (payload as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : null;
}

function numberField(payload: unknown, key: string): number | null {
    if (!payload || typeof payload !== 'object') return null;
    const value = (payload as Record<string, unknown>)[key];
    return typeof value === 'number' ? value : null;
}

async function fetchDisplayName(
    supabase: SupabaseClient,
    userId: string,
): Promise<string | null> {
    const { data, error } = await supabase
        .from('profiles')
        .select('display_name')
        .eq('id', userId)
        .maybeSingle();
    if (error) {
        console.warn('send-push: profile fetch failed', { userId, error });
        return null;
    }
    const name = (data as { display_name?: string } | null)?.display_name;
    return typeof name === 'string' && name.length > 0 ? name : null;
}

async function fetchRecNote(
    supabase: SupabaseClient,
    recId: string,
): Promise<string | null> {
    const { data, error } = await supabase
        .from('recommendations')
        .select('note')
        .eq('id', recId)
        .maybeSingle();
    if (error) return null;
    const note = (data as { note?: string | null } | null)?.note;
    return typeof note === 'string' && note.length > 0 ? note : null;
}

async function fetchTmdbTitle(
    tmdbId: number,
    mediaType: string,
): Promise<string | null> {
    if (mediaType !== 'movie' && mediaType !== 'tv') return null;
    const tmdbToken = Deno.env.get('TMDB_ACCESS_TOKEN');
    if (!tmdbToken) {
        console.warn('send-push: TMDB_ACCESS_TOKEN missing — cannot resolve title');
        return null;
    }
    try {
        const resp = await fetch(`${TMDB_BASE_URL}/${mediaType}/${tmdbId}`, {
            headers: {
                Authorization: `Bearer ${tmdbToken}`,
                Accept: 'application/json',
                // Same `identity` encoding hack as tmdb-proxy — avoids
                // the Deno HTTP body-reader's chunked-decoding bug.
                'Accept-Encoding': 'identity',
            },
        });
        if (!resp.ok) {
            console.warn('send-push: TMDB non-2xx', {
                mediaType,
                tmdbId,
                status: resp.status,
            });
            return null;
        }
        const body = (await resp.json()) as { title?: string; name?: string };
        if (mediaType === 'movie') {
            return typeof body.title === 'string' ? body.title : null;
        }
        return typeof body.name === 'string' ? body.name : null;
    } catch (err) {
        console.warn('send-push: TMDB fetch failed', err);
        return null;
    }
}

// Walks the Expo Push ticket response looking for DeviceNotRegistered
// errors and returns the tokens those tickets correspond to (by index).
// The Expo Push ticket order is parallel to the request order.
function collectStaleTokens(pushes: PushMessage[], rawBody: string): string[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(rawBody);
    } catch {
        console.warn('send-push: malformed Expo ticket response');
        return [];
    }
    if (!parsed || typeof parsed !== 'object' || !('data' in parsed)) return [];
    const tickets = (parsed as { data: unknown }).data;
    if (!Array.isArray(tickets)) return [];

    const stale: string[] = [];
    tickets.forEach((ticket, i) => {
        if (!ticket || typeof ticket !== 'object') return;
        const t = ticket as { status?: string; details?: { error?: string } };
        if (t.status === 'error' && t.details?.error === 'DeviceNotRegistered') {
            const failed = pushes[i]?.to;
            if (failed) stale.push(failed);
        }
    });
    return stale;
}
