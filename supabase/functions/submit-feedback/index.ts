// submit-feedback — saves a feedback row and emails it to the maintainer.
//
// Auth model: authenticated-only. The caller's Supabase user JWT is
// verified, and the DB insert runs through an RLS-scoped client (anon
// key + the user's Authorization header) so `user_id` defaults to
// auth.uid() and the table's RLS insert policy applies — exactly as if
// the client wrote the row directly. The email step uses a SEPARATE
// service-role client purely to read the sender's handle and to sign a
// URL for the (private) screenshot object.
//
// CRITICAL: email is best-effort. The insert is the source of truth —
// if the row saved but the email throws, we STILL return 200 so a
// transient Resend/network failure never loses feedback. The email
// failure is logged server-side only.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers':
        'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const FEEDBACK_BUCKET = 'feedback';
// 7-day signed URL — long enough that the screenshot is still reachable
// from the email days later, short enough that the link doesn't live
// forever.
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 7;
const FEEDBACK_TO = 'thisispaultaylor@icloud.com';
const FEEDBACK_FROM = 'Seen Feedback <onboarding@resend.dev>';

function jsonResponse(body: unknown, status: number): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
}

Deno.serve(async (req: Request) => {
    try {
        if (req.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders });
        }
        if (req.method !== 'POST') {
            return jsonResponse({ error: 'method_not_allowed' }, 405);
        }

        // ---- 1. Authenticate the caller.
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

        // RLS-scoped client: forwards the user's JWT to PostgREST so the
        // insert runs as the user (user_id default = auth.uid(), RLS
        // applies). getUser() ignores the global header and validates the
        // JWT it's handed directly — so we pass `jwt` explicitly.
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

        // ---- 2. Parse + validate the payload.
        let payload: Record<string, unknown>;
        try {
            payload = (await req.json()) as Record<string, unknown>;
        } catch {
            return jsonResponse({ error: 'invalid_json' }, 400);
        }

        const body = typeof payload.body === 'string' ? payload.body : '';
        const screenshotPath =
            typeof payload.screenshot_path === 'string'
                ? payload.screenshot_path
                : null;
        const appVersion =
            typeof payload.app_version === 'string'
                ? payload.app_version
                : 'unknown';
        const device =
            typeof payload.device === 'string' ? payload.device : 'unknown';
        // Optional reply-to address. Trim + treat empty as absent so a
        // blank field doesn't store an empty string.
        const replyEmail =
            typeof payload.reply_email === 'string' &&
            payload.reply_email.trim().length > 0
                ? payload.reply_email.trim()
                : null;

        const trimmedBody = body.trim();
        if (trimmedBody.length === 0) {
            return jsonResponse({ error: 'empty_body' }, 400);
        }

        // ---- 3. Insert (RLS-scoped; user_id defaults to auth.uid()).
        const { error: insertError } = await userClient
            .from('feedback')
            .insert({
                body: trimmedBody,
                screenshot_path: screenshotPath,
                app_version: appVersion,
                device,
                reply_email: replyEmail,
            });
        if (insertError) {
            console.error(
                'submit-feedback insert failed:',
                insertError?.message,
            );
            return jsonResponse(
                { error: 'insert_failed', detail: insertError?.message },
                500,
            );
        }
        // created_at isn't returned (insert-only grant, no RETURNING) —
        // stamp locally for the email.
        const createdAt = new Date().toISOString();

        // ---- 4. Email the maintainer. BEST-EFFORT — never fail the
        //         request from here; the feedback is already saved.
        try {
            const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
                auth: { persistSession: false },
            });

            // Prefer "@handle"; fall back to the raw user id.
            let senderLabel = user.id;
            const { data: profile } = await serviceClient
                .from('profiles')
                .select('handle')
                .eq('id', user.id)
                .maybeSingle();
            if (profile?.handle) senderLabel = `@${profile.handle}`;

            // Signed URL for the private screenshot, if attached.
            let screenshotLine = '';
            if (screenshotPath) {
                const { data: signed, error: signError } =
                    await serviceClient.storage
                        .from(FEEDBACK_BUCKET)
                        .createSignedUrl(
                            screenshotPath,
                            SIGNED_URL_TTL_SECONDS,
                        );
                if (signError || !signed) {
                    console.error(
                        'submit-feedback signed-url failed:',
                        signError?.message,
                    );
                    screenshotLine = `\nScreenshot: (couldn't sign URL — path: ${screenshotPath})`;
                } else {
                    screenshotLine = `\nScreenshot: ${signed.signedUrl}`;
                }
            }

            const resendKey = Deno.env.get('RESEND_API_KEY');
            if (!resendKey) {
                console.error(
                    'submit-feedback: RESEND_API_KEY missing — feedback saved, email skipped',
                );
            } else {
                // Only present when the user opted to leave a reply
                // address — lets the maintainer reply directly.
                const replyLine = replyEmail
                    ? `\nReply to: ${replyEmail}`
                    : '';

                const emailText =
                    `${trimmedBody}\n\n` +
                    `---\n` +
                    `From: ${senderLabel}\n` +
                    `User ID: ${user.id}\n` +
                    `Device: ${device}\n` +
                    `App version: ${appVersion}\n` +
                    `Submitted: ${createdAt}` +
                    replyLine +
                    screenshotLine;

                const resendResp = await fetch('https://api.resend.com/emails', {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${resendKey}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        from: FEEDBACK_FROM,
                        to: FEEDBACK_TO,
                        subject: `Seen feedback from ${senderLabel}`,
                        text: emailText,
                    }),
                });
                if (!resendResp.ok) {
                    const detail = await resendResp.text();
                    console.error(
                        'submit-feedback resend non-2xx:',
                        resendResp.status,
                        detail.slice(0, 300),
                    );
                }
            }
        } catch (emailErr) {
            console.error(
                'submit-feedback email step threw (feedback still saved):',
                emailErr instanceof Error ? emailErr.message : String(emailErr),
            );
        }

        return jsonResponse({ ok: true }, 200);
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.error('submit-feedback unhandled error:', detail);
        return jsonResponse({ error: 'unhandled', detail }, 500);
    }
});
