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
//                 X-Webhook-Secret: <the WEBHOOK_SECRET value from step 2>
//                 (Authorization is auto-populated by Supabase with the
//                  project's anon key, but X-Webhook-Secret is the real
//                  gate — see "Auth model" note below.)
//   2. Edge Function secrets (Settings → Edge Functions):
//        WEBHOOK_SECRET        — REQUIRED. A long random string. Must exactly
//                                 match the X-Webhook-Secret header set on the
//                                 DB webhook above. The function refuses to run
//                                 (500) if this is not set.
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
// Auth model: the DB webhook sends a shared secret in the X-Webhook-Secret
// header, which we verify against WEBHOOK_SECRET before doing anything else
// — this is the real authenticator. The gateway's verify_jwt only proves
// the caller holds SOME valid project JWT, and the project's anon key is
// PUBLIC (shipped in the app bundle), so it cannot distinguish the webhook
// from a forged caller. As defence in depth, the notification row is
// re-fetched from the DB by id and the push is built from THAT row, never
// from the request body — so forged body content can't drive a push even
// if the secret ever leaked.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

type NotificationKind =
    | 'rec_received'
    | 'rec_watched'
    | 'friend_request'
    | 'friend_accepted'
    | 'rec_claimed'
    | 'rec_reacted'
    | 'rec_commented'
    | 'rec_declined'
    | 'rec_requested'
    | 'report_filed'
    | 'chat_commented'
    | 'chat_reacted'
    | 'chat_comment_reacted';

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
    // App-icon badge count. Maps to the APNs `badge` on iOS → the OS sets
    // the icon badge to this absolute number when the push arrives (even
    // with the app closed). Omitted when we couldn't compute a count, in
    // which case iOS leaves the existing badge untouched.
    badge?: number;
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

        // ---- 0. Shared-secret gate (the real authenticator). Reject
        //         before any work if X-Webhook-Secret is missing or doesn't
        //         match WEBHOOK_SECRET. Fail closed if the secret isn't
        //         configured — without it we can't distinguish the webhook
        //         from a forged caller holding the public anon key.
        const expectedSecret = Deno.env.get('WEBHOOK_SECRET');
        if (!expectedSecret) {
            console.error('send-push: WEBHOOK_SECRET not set — refusing');
            return jsonResponse({ error: 'misconfigured' }, 500);
        }
        const providedSecret = req.headers.get('X-Webhook-Secret');
        if (!providedSecret || providedSecret !== expectedSecret) {
            return jsonResponse({ error: 'unauthorized' }, 401);
        }

        // ---- 1. Parse the webhook payload. Only record.id is trusted from
        //         the body — the authoritative row is re-fetched below.
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
        const recordId = body.record?.id;
        if (!recordId) {
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

        // ---- 2b. Re-fetch the notification by id. The push is built from
        //          THIS row, never from body.record — a forged payload can
        //          at most name an id that must actually exist in the table.
        const { data: notifRow, error: notifError } = await supabase
            .from('notifications')
            .select('id, user_id, kind, payload, read_at, created_at')
            .eq('id', recordId)
            .maybeSingle();
        if (notifError) {
            console.error('send-push: notification re-fetch failed', notifError);
            return jsonResponse(
                {
                    error: 'notification_fetch_failed',
                    detail: notifError.message,
                },
                500,
            );
        }
        const notif = notifRow as NotificationRow | null;
        if (!notif || !notif.user_id || !notif.kind) {
            // No such row (forged id, or deleted before we ran) — nothing
            // legitimate to push.
            return jsonResponse({ error: 'notification_not_found' }, 404);
        }

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
        //
        // Dedupe by expo_push_token VALUE before building the pushes
        // array: a physical device can have multiple push_tokens rows
        // (different device_ids accumulated from reinstall cycles —
        // each install wipes AsyncStorage, generates a fresh device_id,
        // and upserts a NEW row), but the underlying Expo push token
        // value is the same one Expo keeps reissuing for that APNs /
        // FCM registration. The reap-on-DeviceNotRegistered safety net
        // doesn't fire here because Expo still considers all those
        // tokens valid (same physical device, same registration).
        // Result without dedup: N banners per push for a user with N
        // duplicate rows. Set-on-value collapses them to one banner per
        // physical device regardless of how many rows accumulated.
        //
        // The reap path below still works correctly: tickets returned
        // by Expo are indexed parallel to the request, so `pushes[i]`
        // alignment holds against the deduped pushes array. The
        // resulting `stale` array contains expo_push_token VALUES, and
        // `.in('expo_push_token', stale)` cleans up every row carrying
        // a dead token regardless of device_id — which is what we
        // want (if Expo says the token is dead, every row with it is
        // dead too).
        // ---- 4b. Recipient's current unread count → app-icon badge.
        //          Calls the SAME public.unread_count SQL the in-app bell
        //          uses (single source of truth), so the icon badge and the
        //          bell always agree. Computed at send time, so it reflects
        //          the state INCLUDING the notification/rec that triggered
        //          this push. service_role runs with no auth.uid(), so the
        //          function's own-user guard lets us pass any recipient uid.
        //
        //          Best-effort: on any RPC failure we still send the push,
        //          just without a `badge` field — iOS then leaves the current
        //          badge untouched, which beats blocking delivery over a
        //          count we couldn't read.
        let badge: number | undefined;
        const { data: badgeCount, error: badgeError } = await supabase.rpc(
            'unread_count',
            { p_uid: notif.user_id },
        );
        if (badgeError) {
            console.warn(
                'send-push: unread_count failed — sending without badge',
                badgeError,
            );
        } else if (typeof badgeCount === 'number') {
            badge = badgeCount;
        }

        const uniqueExpoTokens = Array.from(
            new Set(tokens.map((t) => t.expo_push_token)),
        );
        const pushes: PushMessage[] = uniqueExpoTokens.map((token) => ({
            ...message,
            to: token,
            sound: 'default',
            // Only include `badge` when we actually computed one; an absent
            // field means "don't change the badge", a 0 means "clear it".
            ...(badge !== undefined ? { badge } : {}),
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
            // Optional season coordinate (whole-show when absent/null). It
            // already rides in `data` via the ...notif.payload spread above.
            const season = numberField(notif.payload, 'season');
            if (!fromUserId || !recId || tmdbId === null || !mediaType) return null;

            const [senderName, title, note] = await Promise.all([
                fetchDisplayName(supabase, fromUserId),
                fetchTmdbTitle(tmdbId, mediaType),
                fetchRecNote(supabase, recId),
            ]);
            if (!senderName || !title) return null;

            // A season number is NOT a spoiler the way an episode title is
            // (see the episode-chat suppression in chat_commented), so name it
            // plainly — no redaction. null → whole show.
            const what = season !== null ? `Season ${season} of ${title}` : title;

            return {
                title: `${senderName} recommended ${what}`,
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
            // invite_link:true marks a claim_invite_link friendship:
            // there was no request to accept, so the copy forks.
            const accepterId = stringField(notif.payload, 'from_user_id');
            if (!accepterId) return null;
            const accepterName = await fetchDisplayName(supabase, accepterId);
            if (!accepterName) return null;
            const viaInvite = booleanField(notif.payload, 'invite_link');
            return {
                title: viaInvite
                    ? `${accepterName} joined you on Seen`
                    : `${accepterName} accepted your request`,
                data,
            };
        }
        case 'rec_claimed': {
            // payload.from_user_id is the claimer — someone who joined
            // Seen from this user's rec invite (pending_recommendations →
            // claim_pending_recommendation, 20260712120000). The push
            // routes to the created rec via recommendation_id in data.
            const claimerId = stringField(notif.payload, 'from_user_id');
            if (!claimerId) return null;
            const claimerName = await fetchDisplayName(supabase, claimerId);
            if (!claimerName) return null;
            return {
                title: `${claimerName} joined Seen from your rec`,
                data,
            };
        }
        case 'rec_reacted': {
            // payload.from_user_id is the reactor (other party to the
            // rec). Title fetch is best-effort — if it fails we still
            // push a useful message without the title.
            const reactorId = stringField(notif.payload, 'from_user_id');
            const emoji = stringField(notif.payload, 'emoji');
            const tmdbId = numberField(notif.payload, 'tmdb_id');
            const mediaType = stringField(notif.payload, 'media_type');
            if (!reactorId || !emoji) return null;

            const [reactorName, title] = await Promise.all([
                fetchDisplayName(supabase, reactorId),
                tmdbId !== null && mediaType
                    ? fetchTmdbTitle(tmdbId, mediaType)
                    : Promise.resolve(null),
            ]);
            if (!reactorName) return null;
            return {
                title: title
                    ? `${reactorName} reacted ${emoji} to ${title}`
                    : `${reactorName} reacted ${emoji} to your rec`,
                data,
            };
        }
        case 'rec_commented': {
            // payload.from_user_id is the commenter. Pull the comment
            // body for the push body field; truncate to keep the
            // notification readable on the lock screen.
            const commenterId = stringField(notif.payload, 'from_user_id');
            const commentId = stringField(notif.payload, 'comment_id');
            const tmdbId = numberField(notif.payload, 'tmdb_id');
            const mediaType = stringField(notif.payload, 'media_type');
            if (!commenterId || !commentId) return null;

            const [commenterName, title, body] = await Promise.all([
                fetchDisplayName(supabase, commenterId),
                tmdbId !== null && mediaType
                    ? fetchTmdbTitle(tmdbId, mediaType)
                    : Promise.resolve(null),
                fetchCommentBody(supabase, commentId),
            ]);
            if (!commenterName) return null;
            const bodyPreview = body
                ? body.length > 80
                    ? `${body.slice(0, 80)}…`
                    : body
                : undefined;
            // A comment from the post-watched sheet reads as "watched" (it's the
            // only notification the recipient gets for that watch — the plain
            // rec_watched is suppressed). Body preview stays the same.
            const verb = booleanField(notif.payload, 'from_watched')
                ? 'watched'
                : 'commented on';
            return {
                title: title
                    ? `${commenterName} ${verb} ${title}`
                    : `${commenterName} ${verb} your rec`,
                body: bodyPreview,
                data,
            };
        }
        case 'rec_declined': {
            // payload.from_user_id is the recipient who declined; the note
            // rides in the payload (no separate fetch). Only NOTED declines
            // create this row (silent declines never notify), so a note is
            // always present — but guard + truncate for the lock screen.
            const declinerId = stringField(notif.payload, 'from_user_id');
            const note = stringField(notif.payload, 'note');
            const tmdbId = numberField(notif.payload, 'tmdb_id');
            const mediaType = stringField(notif.payload, 'media_type');
            if (!declinerId) return null;

            const [declinerName, title] = await Promise.all([
                fetchDisplayName(supabase, declinerId),
                tmdbId !== null && mediaType
                    ? fetchTmdbTitle(tmdbId, mediaType)
                    : Promise.resolve(null),
            ]);
            if (!declinerName) return null;
            const notePreview = note
                ? note.length > 80
                    ? `${note.slice(0, 80)}…`
                    : note
                : undefined;
            return {
                // Gentle, sentence case — "passed on", not "declined".
                title: title
                    ? `${declinerName} passed on ${title}`
                    : `${declinerName} passed on your recommendation`,
                body: notePreview,
                data,
            };
        }
        case 'rec_requested': {
            // payload.from_user_id is the requester; the optional note
            // ("what they're in the mood for") rides in the payload.
            const requesterId = stringField(notif.payload, 'from_user_id');
            const note = stringField(notif.payload, 'note');
            if (!requesterId) return null;

            const requesterName = await fetchDisplayName(supabase, requesterId);
            if (!requesterName) return null;
            const notePreview = note
                ? note.length > 80
                    ? `${note.slice(0, 80)}…`
                    : note
                : undefined;
            return {
                title: `${requesterName} asked you for a recommendation`,
                body: notePreview,
                data,
            };
        }
        case 'chat_commented': {
            // A message in a "chat about a title". The chat's FIRST message
            // is the invite → "wants to chat about"; later messages read as
            // plain messages. Body carries the message preview (same 80-char
            // truncation as rec_commented). service_role SELECT on
            // chat_comments is granted by the title_chats migration.
            const senderId = stringField(notif.payload, 'from_user_id');
            const chatId = stringField(notif.payload, 'chat_id');
            const commentId = stringField(notif.payload, 'comment_id');
            const tmdbId = numberField(notif.payload, 'tmdb_id');
            const mediaType = stringField(notif.payload, 'media_type');
            if (!senderId || !chatId || !commentId) return null;

            const [senderName, title, body, isFirst, episode] =
                await Promise.all([
                    fetchDisplayName(supabase, senderId),
                    tmdbId !== null && mediaType
                        ? fetchTmdbTitle(tmdbId, mediaType)
                        : Promise.resolve(null),
                    fetchChatCommentBody(supabase, commentId),
                    isFirstChatComment(supabase, chatId, commentId),
                    // Parallel with the others → no added latency. Tells us
                    // whether this is an episode chat.
                    fetchChatEpisode(supabase, chatId),
                ]);
            if (!senderName) return null;

            // EPISODE CHAT: the episode label is the only spoiler protection,
            // and the push is the surface where a spoiler does the most damage
            // (read on the lock screen before you know what it's about). So put
            // the coordinate in the TITLE and SUPPRESS the message body — never
            // send the message text for an episode chat.
            if (episode) {
                const coord = `S${episode.season} E${episode.episode}`;
                const verbed = isFirst
                    ? title
                        ? `${senderName} wants to chat about ${title} ${coord}`
                        : `${senderName} wants to chat about an episode`
                    : title
                      ? `${senderName} sent a message about ${title} ${coord}`
                      : `${senderName} sent a message about an episode`;
                return { title: verbed, data };
            }

            // WHOLE-SHOW CHAT: unchanged — title-level copy + message preview.
            const bodyPreview = body
                ? body.length > 80
                    ? `${body.slice(0, 80)}…`
                    : body
                : undefined;
            const verbed = isFirst
                ? title
                    ? `${senderName} wants to chat about ${title}`
                    : `${senderName} wants to chat`
                : title
                  ? `${senderName} sent a message about ${title}`
                  : `${senderName} sent you a message`;
            return {
                title: verbed,
                body: bodyPreview,
                data,
            };
        }
        case 'chat_reacted': {
            // Reaction on the chat itself, from the other party.
            const reactorId = stringField(notif.payload, 'from_user_id');
            const emoji = stringField(notif.payload, 'emoji');
            const tmdbId = numberField(notif.payload, 'tmdb_id');
            const mediaType = stringField(notif.payload, 'media_type');
            if (!reactorId || !emoji) return null;

            const [reactorName, title] = await Promise.all([
                fetchDisplayName(supabase, reactorId),
                tmdbId !== null && mediaType
                    ? fetchTmdbTitle(tmdbId, mediaType)
                    : Promise.resolve(null),
            ]);
            if (!reactorName) return null;
            return {
                title: title
                    ? `${reactorName} reacted ${emoji} to your chat about ${title}`
                    : `${reactorName} reacted ${emoji} to your chat`,
                data,
            };
        }
        // NB: no 'chat_comment_reacted' case — comment-reactions are
        // inbox-only, matching the rec side ('comment_reacted' has no case
        // either). The kind stays in NotificationKind for typing; buildMessage
        // returns null via the default and no push is sent.
        case 'report_filed': {
            // Maintainer alert for a new content report. Payload carries only
            // the reason + reported_type — NO reporter identity, so neither the
            // title nor the body names who reported. reason is nullable in the
            // reports table (the app always sends one from the picker, but
            // guard anyway).
            const reason = stringField(notif.payload, 'reason');
            const reportedType = stringField(notif.payload, 'reported_type');
            return {
                title: reportedType
                    ? `New ${reportedType} report`
                    : 'New content report',
                body: reason ? `Reason: ${reason}` : 'No reason given',
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

function booleanField(payload: unknown, key: string): boolean {
    if (!payload || typeof payload !== 'object') return false;
    return (payload as Record<string, unknown>)[key] === true;
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

async function fetchCommentBody(
    supabase: SupabaseClient,
    commentId: string,
): Promise<string | null> {
    const { data, error } = await supabase
        .from('recommendation_comments')
        .select('body')
        .eq('id', commentId)
        .maybeSingle();
    if (error) return null;
    const body = (data as { body?: string | null } | null)?.body;
    return typeof body === 'string' && body.length > 0 ? body : null;
}

// Chat-comment analog of fetchCommentBody. service_role SELECT on
// chat_comments is granted by the title_chats migration (20260709180000).
async function fetchChatCommentBody(
    supabase: SupabaseClient,
    commentId: string,
): Promise<string | null> {
    const { data, error } = await supabase
        .from('chat_comments')
        .select('body')
        .eq('id', commentId)
        .maybeSingle();
    if (error) return null;
    const body = (data as { body?: string | null } | null)?.body;
    return typeof body === 'string' && body.length > 0 ? body : null;
}

// A chat's episode scope, if any. Both null = whole-show chat; both set =
// episode chat. Best-effort: on any error we treat it as whole-show (the push
// then reads exactly as before). service_role SELECT on title_chats is granted
// by the title_chats migration.
async function fetchChatEpisode(
    supabase: SupabaseClient,
    chatId: string,
): Promise<{ season: number; episode: number } | null> {
    const { data, error } = await supabase
        .from('title_chats')
        .select('season, episode')
        .eq('id', chatId)
        .maybeSingle();
    if (error) return null;
    const row = data as { season?: number | null; episode?: number | null } | null;
    return typeof row?.season === 'number' && typeof row?.episode === 'number'
        ? { season: row.season, episode: row.episode }
        : null;
}

// Is this comment the chat's FIRST message (the invite)? Best-effort: any
// query error → false (plain-message wording), never a dropped push.
async function isFirstChatComment(
    supabase: SupabaseClient,
    chatId: string,
    commentId: string,
): Promise<boolean> {
    const { data, error } = await supabase
        .from('chat_comments')
        .select('id')
        .eq('chat_id', chatId)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
    if (error) return false;
    return (data as { id?: string } | null)?.id === commentId;
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
