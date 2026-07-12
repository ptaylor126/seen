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
    claimPendingRec,
    parseInviteToken,
} from '@/lib/pending-recs';
import {
    button,
    getPalette,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

// "Have an invite link?" — the claim entry point, shared by the onboarding
// invite step and friends/add. Deliberately quiet: a text link that expands
// in place to a paste field + Claim button, so it never competes with the
// host screen's primary action. Accepts the full seenrecs.com/r/ URL or a
// bare token; on success the caller routes (the RPC has already created the
// rec AND the friendship — no extra UI for the friendship, it just exists).
export function ClaimInvite({
    onClaimed,
}: {
    onClaimed: (recId: string) => void;
}) {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const [expanded, setExpanded] = useState(false);
    const [value, setValue] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function handleClaim() {
        if (busy) return;
        const token = parseInviteToken(value);
        if (!token) {
            setError("That doesn't look like an invite link.");
            return;
        }
        setBusy(true);
        setError(null);
        try {
            const result = await claimPendingRec(token);
            if (result.ok) {
                onClaimed(result.recId);
            } else {
                setError(CLAIM_ERROR_COPY[result.error]);
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
