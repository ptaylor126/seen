import { useState } from 'react';
import {
    ActivityIndicator,
    Pressable,
    StyleSheet,
    Text,
    TextInput,
    useColorScheme,
    View,
} from 'react-native';

import {
    CLAIM_ERROR_COPY,
    claimFriendInvite,
    claimPendingRec,
    parseInviteInput,
} from '@/lib/pending-recs';
import {
    button,
    getPalette,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

// What a successful claim resolved to — the host routes on it: a rec
// invite lands on the created rec's screen, a friend invite on the new
// friend's profile.
export type ClaimedTarget =
    | { type: 'rec'; recId: string }
    | { type: 'friend'; userId: string };

// "Have an invite link?" — the claim entry point, shared by the onboarding
// invite step and friends/add. Deliberately quiet: a text link that expands
// in place to a paste field + Claim button, so it never competes with the
// host screen's primary action.
//
// One paste field, TWO token families: rec invites (seenrecs.com/r/ →
// claim_pending_recommendation) and friend invites (seenrecs.com/i/ →
// claim_invite_link). A full URL disambiguates by path; a bare token is
// shape-identical for both (same generator), so we try the rec claim
// first and fall through to the friend claim on not_found. Either way the
// server has already created the rec and/or friendship when onClaimed
// fires — no extra UI for the friendship, it just exists.
export function ClaimInvite({
    onClaimed,
}: {
    onClaimed: (target: ClaimedTarget) => void;
}) {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const [expanded, setExpanded] = useState(false);
    const [value, setValue] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function handleClaim() {
        if (busy) return;
        const parsed = parseInviteInput(value);
        if (!parsed) {
            setError("That doesn't look like an invite link.");
            return;
        }
        setBusy(true);
        setError(null);
        try {
            // Friend-hinted (/i/ URL) → friend claim only.
            if (parsed.hint === 'friend') {
                const result = await claimFriendInvite(parsed.token);
                if (result.ok) {
                    onClaimed({ type: 'friend', userId: result.userId });
                } else {
                    setError(CLAIM_ERROR_COPY[result.error]);
                }
                return;
            }
            // Rec-hinted (/r/ URL) or bare token: rec claim first. For a
            // bare token, ONLY not_found falls through to the friend claim
            // (any other error means the token matched the rec table and
            // failed for a real reason worth surfacing).
            const recResult = await claimPendingRec(parsed.token);
            if (recResult.ok) {
                onClaimed({ type: 'rec', recId: recResult.recId });
                return;
            }
            if (parsed.hint === 'rec' || recResult.error !== 'not_found') {
                setError(CLAIM_ERROR_COPY[recResult.error]);
                return;
            }
            const friendResult = await claimFriendInvite(parsed.token);
            if (friendResult.ok) {
                onClaimed({ type: 'friend', userId: friendResult.userId });
            } else {
                setError(CLAIM_ERROR_COPY[friendResult.error]);
            }
        } finally {
            setBusy(false);
        }
    }

    if (!expanded) {
        return (
            <Pressable
                onPress={() => setExpanded(true)}
                hitSlop={spacing.sm}
                accessibilityRole="button"
                accessibilityLabel="Claim an invite link"
                style={({ pressed }) => [
                    styles.collapsedLink,
                    { opacity: pressed ? 0.6 : 1 },
                ]}
            >
                <Text style={[typography.body, { color: palette.accent }]}>
                    Have an invite link?
                </Text>
            </Pressable>
        );
    }

    return (
        <View style={styles.group}>
            <TextInput
                value={value}
                onChangeText={(v) => {
                    setValue(v);
                    if (error) setError(null);
                }}
                placeholder="Paste your invite link"
                placeholderTextColor={palette.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
                editable={!busy}
                onSubmitEditing={() => void handleClaim()}
                returnKeyType="go"
                style={[
                    styles.input,
                    typography.body,
                    {
                        backgroundColor: palette.surface,
                        color: palette.text,
                    },
                ]}
            />
            {error ? (
                <Text
                    style={[
                        typography.caption,
                        styles.errorText,
                        { color: palette.error },
                    ]}
                >
                    {error}
                </Text>
            ) : null}
            <Pressable
                onPress={() => void handleClaim()}
                disabled={busy || value.trim().length === 0}
                accessibilityRole="button"
                accessibilityLabel="Claim invite"
                style={({ pressed }) => [
                    styles.claimButton,
                    {
                        backgroundColor: palette.accent,
                        opacity:
                            value.trim().length === 0
                                ? 0.4
                                : pressed || busy
                                  ? 0.6
                                  : 1,
                    },
                ]}
            >
                {busy ? (
                    <ActivityIndicator color={palette.textInverse} />
                ) : (
                    <Text
                        style={[
                            typography.bodyEmphasis,
                            { color: palette.textInverse },
                        ]}
                    >
                        Claim
                    </Text>
                )}
            </Pressable>
        </View>
    );
}

const styles = StyleSheet.create({
    collapsedLink: {
        alignSelf: 'center',
        paddingVertical: spacing.sm,
        paddingHorizontal: spacing.base,
    },
    group: {
        gap: spacing.sm,
    },
    input: {
        borderRadius: radius.sm,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.md,
    },
    errorText: {
        textAlign: 'center',
    },
    claimButton: {
        paddingVertical: button.paddingVertical,
        borderRadius: button.borderRadius,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
