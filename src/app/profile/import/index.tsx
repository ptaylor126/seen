/**
 * Import your library — source selection.
 *
 * Entry point (Profile → Import your library, gated on
 * LIBRARY_IMPORT_ENABLED). Pick a source, read the short how-to-export
 * steps, then pick the export file. Parsing/resolution/preview all
 * happen on the run screen; nothing is written from here.
 */
import * as DocumentPicker from 'expo-document-picker';
import { useRouter } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useState } from 'react';
import {
    Alert,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    useColorScheme,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
    IMPORT_SOURCE_LIST,
    type SourceDefinition,
} from '@/lib/import/registry';
import {
    getPalette,
    ICON_STROKE_WIDTH,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

export default function ImportSourceScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const router = useRouter();

    const [selected, setSelected] = useState<SourceDefinition | null>(null);
    const [picking, setPicking] = useState(false);

    async function pickFile(source: SourceDefinition) {
        if (picking) return;
        setPicking(true);
        try {
            const result = await DocumentPicker.getDocumentAsync({
                type: source.pickerTypes,
                copyToCacheDirectory: true,
                multiple: false,
            });
            if (result.canceled || result.assets.length === 0) return;
            const asset = result.assets[0];
            router.push({
                pathname: '/profile/import/run',
                params: {
                    source: source.id,
                    uri: asset.uri,
                    name: asset.name,
                },
            });
        } catch (err) {
            console.error('document pick failed:', err);
            Alert.alert(
                "Couldn't open that file",
                'Something went wrong picking the file. Please try again.',
            );
        } finally {
            setPicking(false);
        }
    }

    return (
        <SafeAreaView
            style={[styles.root, { backgroundColor: palette.bg }]}
            edges={['top']}
        >
            <View style={styles.header}>
                <Pressable
                    onPress={() => router.back()}
                    hitSlop={spacing.sm}
                    style={({ pressed }) => [pressed && { opacity: 0.6 }]}
                >
                    <ChevronLeft
                        color={palette.accent}
                        size={28}
                        strokeWidth={ICON_STROKE_WIDTH}
                    />
                </Pressable>
                <Text style={[typography.heading, { color: palette.text }]}>
                    Import your library
                </Text>
            </View>

            <ScrollView contentContainerStyle={styles.body}>
                <Text style={[typography.body, { color: palette.textMuted }]}>
                    Bring your watch history over from another app. You&apos;ll
                    see everything before it&apos;s added. Nothing is imported
                    until you confirm.
                </Text>

                {IMPORT_SOURCE_LIST.map((source) => {
                    const isSelected = selected?.id === source.id;
                    return (
                        <View
                            key={source.id}
                            style={[
                                styles.sourceCard,
                                {
                                    backgroundColor: palette.surface,
                                    borderColor: isSelected
                                        ? palette.accent
                                        : palette.border,
                                },
                            ]}
                        >
                            <Pressable
                                onPress={() =>
                                    setSelected(isSelected ? null : source)
                                }
                                accessibilityRole="button"
                                accessibilityLabel={`Import from ${source.label}`}
                                style={({ pressed }) => [
                                    styles.sourceHead,
                                    pressed && { opacity: 0.6 },
                                ]}
                            >
                                <Text
                                    style={[
                                        typography.bodyEmphasis,
                                        { color: palette.text },
                                    ]}
                                >
                                    {source.label}
                                </Text>
                            </Pressable>
                            {isSelected && (
                                <View style={styles.sourceDetail}>
                                    {source.instructions.map((step, i) => (
                                        <View key={i} style={styles.stepRow}>
                                            <Text
                                                style={[
                                                    typography.caption,
                                                    styles.stepNumber,
                                                    { color: palette.accent },
                                                ]}
                                            >
                                                {i + 1}
                                            </Text>
                                            <Text
                                                style={[
                                                    typography.caption,
                                                    styles.stepText,
                                                    { color: palette.textMuted },
                                                ]}
                                            >
                                                {step}
                                            </Text>
                                        </View>
                                    ))}
                                    <Pressable
                                        onPress={() => void pickFile(source)}
                                        disabled={picking}
                                        accessibilityRole="button"
                                        accessibilityLabel="Choose file"
                                        style={({ pressed }) => [
                                            styles.chooseButton,
                                            {
                                                backgroundColor: palette.accent,
                                                opacity:
                                                    picking || pressed ? 0.6 : 1,
                                            },
                                        ]}
                                    >
                                        <Text
                                            style={[
                                                typography.bodyEmphasis,
                                                { color: palette.textInverse },
                                            ]}
                                        >
                                            Choose file
                                        </Text>
                                    </Pressable>
                                </View>
                            )}
                        </View>
                    );
                })}
            </ScrollView>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1 },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.base,
        paddingVertical: spacing.sm,
        gap: spacing.sm,
    },
    body: {
        paddingHorizontal: spacing.base,
        paddingTop: spacing.md,
        paddingBottom: spacing.xl,
        gap: spacing.md,
    },
    sourceCard: {
        borderRadius: radius.md,
        borderWidth: 1,
        overflow: 'hidden',
    },
    sourceHead: {
        paddingHorizontal: spacing.base,
        paddingVertical: spacing.base,
    },
    sourceDetail: {
        paddingHorizontal: spacing.base,
        paddingBottom: spacing.base,
        gap: spacing.sm,
    },
    stepRow: {
        flexDirection: 'row',
        gap: spacing.sm,
    },
    stepNumber: {
        width: 14,
        textAlign: 'right',
    },
    stepText: { flex: 1 },
    chooseButton: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: spacing.md,
        borderRadius: radius.sm,
        marginTop: spacing.sm,
    },
});
