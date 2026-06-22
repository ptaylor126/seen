/**
 * Content reporting (App Store Guideline 1.2).
 *
 * One reusable flow for flagging objectionable user-generated content —
 * a recommendation note, a comment, a review, or a user profile. Every
 * report surface in the app funnels through `promptReport()` so there's a
 * single reason picker, a single insert path, and a single acknowledgement.
 *
 * State is write-only from the client: `reportContent()` inserts one row
 * into `public.reports` (reporter_id defaults to auth.uid() server-side via
 * the column default + RLS); the maintainer reads + acts on reports from the
 * Supabase dashboard. There is no client read-back.
 *
 * Nothing here can crash a screen — the insert is wrapped, and the prompt is
 * fire-and-forget.
 */
import { Alert } from 'react-native';

import supabase from '@/lib/supabase';

export type ReportedType = 'recommendation' | 'comment' | 'review' | 'profile';

// The reasons offered in the picker. Free text in the DB, so this list can
// grow without a migration.
const REPORT_REASONS = ['Spam', 'Harassment', 'Inappropriate', 'Other'] as const;

/**
 * Insert one report row. Returns true on success, false on any failure —
 * never throws, so callers can't crash a screen. `reporter_id` is NOT passed:
 * the column defaults to auth.uid() and RLS enforces it = the caller.
 */
export async function reportContent(args: {
    type: ReportedType;
    id: string;
    reportedUserId?: string | null;
    reason?: string | null;
}): Promise<boolean> {
    try {
        const { error } = await supabase.from('reports').insert({
            reported_type: args.type,
            reported_id: args.id,
            reported_user_id: args.reportedUserId ?? null,
            reason: args.reason ?? null,
        });
        if (error) throw error;
        return true;
    } catch (err) {
        console.warn('report submit failed:', err);
        return false;
    }
}

/**
 * The shared Report action: opens a reason action-sheet, submits the chosen
 * reason via reportContent, then shows a brief acknowledgement. Fire-and-
 * forget — call from any surface's menu/long-press. Callers are responsible
 * for NOT offering this on the viewer's own content (reporting yourself makes
 * no sense); see each wiring site's author check.
 */
export function promptReport(args: {
    type: ReportedType;
    id: string;
    reportedUserId?: string | null;
    /** Sheet title, e.g. "Report comment" / "Report user". */
    title?: string;
}): void {
    Alert.alert(args.title ?? 'Report', 'Why are you reporting this?', [
        ...REPORT_REASONS.map((reason) => ({
            text: reason,
            onPress: () => {
                void (async () => {
                    const ok = await reportContent({
                        type: args.type,
                        id: args.id,
                        reportedUserId: args.reportedUserId,
                        reason,
                    });
                    Alert.alert(
                        ok ? 'Thanks — we’ll review this' : 'Couldn’t submit report',
                        ok
                            ? 'Our team will take a look. Thanks for helping keep Seen safe.'
                            : 'Something went wrong. Please try again.',
                    );
                })();
            },
        })),
        { text: 'Cancel', style: 'cancel' as const },
    ]);
}
