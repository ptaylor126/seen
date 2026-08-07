/**
 * Import your library — the run screen. One stateful flow:
 *
 *   preparing  → read + parse the picked file, load existing library keys
 *   resolving  → parsed rows → TMDB titles (throttled, progress shown)
 *   preview    → grouped review UI; every row fixable via the match
 *                sheet. NO WRITES have happened up to this point.
 *   importing  → chunked, idempotent items inserts (skip-existing)
 *   done       → counts + per-row failures
 *
 * Back navigation is blocked while importing (writes in flight); at any
 * earlier phase leaving simply abandons the read-only run.
 */
import { Image } from 'expo-image';
import { File } from 'expo-file-system';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useNavigation, usePreventRemove } from '@react-navigation/native';
import { ChevronLeft } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Modal,
    Pressable,
    SectionList,
    StyleSheet,
    Text,
    useColorScheme,
    View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { IMPORT_SOURCES } from '@/lib/import/registry';
import { resolveRow, resolveRows } from '@/lib/import/resolve';
import {
    chosenCandidate,
    ImportParseError,
    type Candidate,
    type ImportOutcome,
    type ImportSource,
    type PreviewRow,
} from '@/lib/import/types';
import { fetchExistingKeys, itemKey, runImport } from '@/lib/import/write';
import { formatRatingStars } from '@/lib/rating';
import supabase from '@/lib/supabase';
import { imageUrl } from '@/lib/tmdb';
import {
    getPalette,
    ICON_STROKE_WIDTH,
    radius,
    spacing,
    typography,
    type Palette,
} from '@/theme/theme';

type Phase =
    | { kind: 'preparing' }
    | { kind: 'resolving'; done: number; total: number }
    | { kind: 'preview' }
    | { kind: 'importing'; done: number; total: number }
    | { kind: 'done'; outcome: ImportOutcome }
    | { kind: 'error'; message: string };

const POSTER_W = 44;
const POSTER_H = 66;

function attentionLabel(row: PreviewRow): string {
    switch (row.resolution.kind) {
        case 'ambiguous':
            return 'Choose the right match';
        case 'unmatched':
            return 'No match found';
        case 'failed':
            return 'Lookup failed · tap to retry';
        default:
            return '';
    }
}

function statusLabel(row: PreviewRow): string {
    if (row.parsed.status === 'watchlist') return 'Watchlist';
    return row.parsed.rating !== null
        ? `Watched · ${formatRatingStars(row.parsed.rating)}`
        : 'Watched';
}

export default function ImportRunScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const params = useLocalSearchParams<{
        source: string;
        uri: string;
        name: string;
    }>();

    const [phase, setPhase] = useState<Phase>({ kind: 'preparing' });
    const [rows, setRows] = useState<PreviewRow[]>([]);
    const [unsupported, setUnsupported] = useState(0);
    const [existingKeys, setExistingKeys] = useState<Set<string>>(new Set());
    const [userId, setUserId] = useState<string | null>(null);
    const [sheetKey, setSheetKey] = useState<string | null>(null);
    const [sheetBusy, setSheetBusy] = useState(false);
    const stopRef = useRef(false);
    const navigation = useNavigation();

    // Make the no-writes-before-confirm guarantee VISIBLE on the way
    // out, not just true in the code: leaving the review gets an
    // explicit "nothing has been imported" confirm. Covers the header
    // back button, the iOS back-swipe and the Android hardware back in
    // one place. While importing (writes in flight) leaving is blocked
    // outright — the phase ends on its own within seconds.
    usePreventRemove(
        phase.kind === 'preview' || phase.kind === 'importing',
        ({ data }) => {
            if (phase.kind === 'importing') {
                Alert.alert(
                    'Import in progress',
                    'Hang on a moment. You can leave as soon as it finishes.',
                );
                return;
            }
            Alert.alert('Leave import?', 'Nothing has been imported.', [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Leave',
                    style: 'destructive',
                    onPress: () => navigation.dispatch(data.action),
                },
            ]);
        },
    );

    useEffect(() => {
        stopRef.current = false;
        let active = true;
        (async () => {
            try {
                const source = params.source as ImportSource;
                const def = IMPORT_SOURCES[source];
                if (!def || !params.uri) {
                    throw new ImportParseError(
                        'This import link is invalid. Go back and pick the file again.',
                    );
                }

                const bytes = await new File(params.uri).bytes();
                const parsed = def.parse({
                    name: params.name ?? '',
                    bytes,
                });

                const {
                    data: { session },
                } = await supabase.auth.getSession();
                const uid = session?.user.id;
                if (!uid) throw new Error('Not authenticated');
                if (!active) return;
                setUserId(uid);
                setUnsupported(parsed.unsupported);

                const keys = await fetchExistingKeys(uid);
                if (!active) return;
                setExistingKeys(keys);

                setPhase({
                    kind: 'resolving',
                    done: 0,
                    total: parsed.rows.length,
                });
                const resolutions = await resolveRows(parsed.rows, {
                    onProgress: (done, total) => {
                        if (active) setPhase({ kind: 'resolving', done, total });
                    },
                    shouldStop: () => stopRef.current,
                });
                if (!active || stopRef.current) return;

                setRows(
                    parsed.rows.map((p, i) => {
                        const resolution = resolutions[i];
                        const candidate =
                            resolution.kind === 'matched'
                                ? resolution.candidate
                                : null;
                        return {
                            parsed: p,
                            resolution,
                            inLibrary: candidate
                                ? keys.has(itemKey(candidate))
                                : false,
                            excluded: false,
                        };
                    }),
                );
                setPhase({ kind: 'preview' });
            } catch (err) {
                if (!active) return;
                console.error('import run failed:', err);
                setPhase({
                    kind: 'error',
                    message:
                        err instanceof ImportParseError
                            ? err.message
                            : "Something went wrong reading that file. Check your connection and try again.",
                });
            }
        })();
        return () => {
            active = false;
            stopRef.current = true;
        };
        // Params are stable for the lifetime of this screen instance.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    function updateRow(key: string, patch: (row: PreviewRow) => PreviewRow) {
        setRows((prev) =>
            prev.map((r) => (r.parsed.key === key ? patch(r) : r)),
        );
    }

    function chooseCandidate(key: string, candidate: Candidate) {
        updateRow(key, (r) => ({
            ...r,
            resolution: {
                kind: 'matched',
                candidate,
                candidates:
                    r.resolution.kind === 'matched' ||
                    r.resolution.kind === 'ambiguous'
                        ? r.resolution.candidates
                        : [candidate],
            },
            inLibrary: existingKeys.has(itemKey(candidate)),
            excluded: false,
        }));
        setSheetKey(null);
    }

    async function retryRow(key: string) {
        const row = rows.find((r) => r.parsed.key === key);
        if (!row || sheetBusy) return;
        setSheetBusy(true);
        try {
            const resolution = await resolveRow(row.parsed);
            const candidate =
                resolution.kind === 'matched' ? resolution.candidate : null;
            updateRow(key, (r) => ({
                ...r,
                resolution,
                inLibrary: candidate
                    ? existingKeys.has(itemKey(candidate))
                    : false,
            }));
        } finally {
            setSheetBusy(false);
        }
    }

    async function startImport() {
        if (!userId || phase.kind !== 'preview') return;
        const total = rows.filter(
            (r) => !r.excluded && !r.inLibrary && chosenCandidate(r) !== null,
        ).length;
        setPhase({ kind: 'importing', done: 0, total });
        try {
            const outcome = await runImport(userId, rows, (done, t) =>
                setPhase({ kind: 'importing', done, total: t }),
            );
            setPhase({ kind: 'done', outcome });
        } catch (err) {
            // runImport isolates row failures; reaching here means an
            // infrastructural failure (e.g. offline before any chunk).
            // Idempotent writes make "just try again" safe advice.
            console.error('import failed:', err);
            setPhase({
                kind: 'error',
                message:
                    'The import ran into a connection problem. Anything already imported is saved; run the same file again to finish the rest.',
            });
        }
    }

    // ---- derived preview grouping -------------------------------------
    const needsAttention = rows.filter(
        (r) => !r.excluded && chosenCandidate(r) === null,
    );
    const ready = rows.filter(
        (r) => !r.excluded && !r.inLibrary && chosenCandidate(r) !== null,
    );
    const already = rows.filter(
        (r) => !r.excluded && r.inLibrary && chosenCandidate(r) !== null,
    );
    const excludedRows = rows.filter((r) => r.excluded);

    const sheetRow = sheetKey
        ? (rows.find((r) => r.parsed.key === sheetKey) ?? null)
        : null;

    const importing = phase.kind === 'importing';

    return (
        <SafeAreaView
            style={[styles.root, { backgroundColor: palette.bg }]}
            edges={['top']}
        >
            <Stack.Screen options={{ gestureEnabled: !importing }} />
            <View style={styles.header}>
                {!importing && (
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
                )}
                <Text style={[typography.heading, { color: palette.text }]}>
                    {phase.kind === 'done' ? 'Import complete' : 'Review import'}
                </Text>
            </View>

            {(phase.kind === 'preparing' || phase.kind === 'resolving') && (
                <View style={styles.fillCenter}>
                    {phase.kind === 'resolving' ? (
                        <>
                            <ProgressBar
                                palette={palette}
                                fraction={
                                    phase.total > 0
                                        ? phase.done / phase.total
                                        : 0
                                }
                            />
                            <Text
                                style={[
                                    typography.body,
                                    styles.progressText,
                                    { color: palette.textMuted },
                                ]}
                            >
                                Matching {phase.done} of {phase.total} titles
                            </Text>
                        </>
                    ) : (
                        <>
                            <ActivityIndicator color={palette.accent} />
                            <Text
                                style={[
                                    typography.body,
                                    styles.progressText,
                                    { color: palette.textMuted },
                                ]}
                            >
                                Reading your export
                            </Text>
                        </>
                    )}
                </View>
            )}

            {phase.kind === 'error' && (
                <View style={styles.fillCenter}>
                    <Text
                        style={[
                            typography.body,
                            styles.errorText,
                            { color: palette.text },
                        ]}
                    >
                        {phase.message}
                    </Text>
                    <Pressable
                        onPress={() => router.back()}
                        style={({ pressed }) => [
                            styles.secondaryButton,
                            { borderColor: palette.border },
                            pressed && { opacity: 0.6 },
                        ]}
                    >
                        <Text style={[typography.body, { color: palette.text }]}>
                            Go back
                        </Text>
                    </Pressable>
                </View>
            )}

            {phase.kind === 'preview' && (
                <>
                    <SectionList
                        sections={[
                            {
                                key: 'attention',
                                title: `Needs attention (${needsAttention.length})`,
                                data: needsAttention,
                            },
                            {
                                key: 'ready',
                                title: `Ready to import (${ready.length})`,
                                data: ready,
                            },
                            {
                                key: 'already',
                                title: `Already in your library (${already.length})`,
                                data: already,
                            },
                            {
                                key: 'excluded',
                                title: `Excluded (${excludedRows.length})`,
                                data: excludedRows,
                            },
                        ].filter((s) => s.data.length > 0)}
                        keyExtractor={(row) => row.parsed.key}
                        renderSectionHeader={({ section }) => (
                            <Text
                                style={[
                                    typography.overline,
                                    styles.sectionHeader,
                                    {
                                        color: palette.textMuted,
                                        backgroundColor: palette.bg,
                                    },
                                ]}
                            >
                                {section.title}
                            </Text>
                        )}
                        renderItem={({ item }) => (
                            <PreviewListRow
                                row={item}
                                palette={palette}
                                onPress={() => setSheetKey(item.parsed.key)}
                            />
                        )}
                        contentContainerStyle={styles.listContent}
                        stickySectionHeadersEnabled={false}
                        ListHeaderComponent={
                            unsupported > 0 ? (
                                <Text
                                    style={[
                                        typography.caption,
                                        styles.unsupportedNote,
                                        { color: palette.textMuted },
                                    ]}
                                >
                                    {unsupported} episode rating
                                    {unsupported === 1 ? '' : 's'} skipped ·
                                    Seen tracks whole shows
                                </Text>
                            ) : null
                        }
                    />
                    <View
                        style={[
                            styles.footer,
                            {
                                backgroundColor: palette.bg,
                                borderTopColor: palette.border,
                                paddingBottom: Math.max(
                                    spacing.md,
                                    insets.bottom + spacing.xs,
                                ),
                            },
                        ]}
                    >
                        <Pressable
                            onPress={() => void startImport()}
                            disabled={ready.length === 0}
                            accessibilityRole="button"
                            accessibilityLabel="Import titles"
                            style={({ pressed }) => [
                                styles.primaryButton,
                                {
                                    backgroundColor: palette.accent,
                                    opacity:
                                        ready.length === 0
                                            ? 0.4
                                            : pressed
                                              ? 0.6
                                              : 1,
                                },
                            ]}
                        >
                            <Text
                                style={[
                                    typography.bodyEmphasis,
                                    { color: palette.textInverse },
                                ]}
                            >
                                {/* Skipping unresolved rows is an explicit
                                    choice on the button, not an implicit
                                    side effect of importing. */}
                                {needsAttention.length > 0
                                    ? `Skip ${needsAttention.length} and import ${ready.length}`
                                    : `Import ${ready.length} title${
                                          ready.length === 1 ? '' : 's'
                                      }`}
                            </Text>
                        </Pressable>
                    </View>
                </>
            )}

            {phase.kind === 'importing' && (
                <View style={styles.fillCenter}>
                    <ProgressBar
                        palette={palette}
                        fraction={phase.total > 0 ? phase.done / phase.total : 0}
                    />
                    <Text
                        style={[
                            typography.body,
                            styles.progressText,
                            { color: palette.textMuted },
                        ]}
                    >
                        Importing {phase.done} of {phase.total} titles
                    </Text>
                </View>
            )}

            {phase.kind === 'done' && (
                <View style={styles.doneBody}>
                    <Text style={[typography.display, { color: palette.text }]}>
                        {phase.outcome.imported}
                    </Text>
                    <Text style={[typography.body, { color: palette.textMuted }]}>
                        title{phase.outcome.imported === 1 ? '' : 's'} imported
                    </Text>
                    <View style={styles.doneCounts}>
                        <Text
                            style={[
                                typography.caption,
                                { color: palette.textMuted },
                            ]}
                        >
                            {phase.outcome.skipped} already in your library ·{' '}
                            {phase.outcome.excluded} excluded
                            {phase.outcome.failed.length > 0
                                ? ` · ${phase.outcome.failed.length} failed`
                                : ''}
                        </Text>
                        {phase.outcome.failed.length > 0 && (
                            <Text
                                style={[
                                    typography.caption,
                                    styles.failedList,
                                    { color: palette.error },
                                ]}
                            >
                                Failed:{' '}
                                {phase.outcome.failed
                                    .map((r) => r.parsed.name)
                                    .join(', ')}
                                {'\n'}Running the same file again retries just
                                these · everything else is skipped safely.
                            </Text>
                        )}
                    </View>
                    <Pressable
                        onPress={() => router.dismissAll()}
                        accessibilityRole="button"
                        accessibilityLabel="Done"
                        style={({ pressed }) => [
                            styles.primaryButton,
                            styles.doneButton,
                            {
                                backgroundColor: palette.accent,
                                opacity: pressed ? 0.6 : 1,
                            },
                        ]}
                    >
                        <Text
                            style={[
                                typography.bodyEmphasis,
                                { color: palette.textInverse },
                            ]}
                        >
                            Done
                        </Text>
                    </Pressable>
                </View>
            )}

            {/* Match-correction sheet — candidates for the tapped row,
                exclude/include toggle, retry for failed lookups. */}
            <Modal
                visible={sheetRow !== null}
                transparent
                animationType="slide"
                onRequestClose={() => setSheetKey(null)}
            >
                <View style={styles.sheetScrim}>
                    <Pressable
                        style={StyleSheet.absoluteFill}
                        onPress={() => setSheetKey(null)}
                        accessibilityElementsHidden
                    />
                    {sheetRow && (
                        <View
                            style={[
                                styles.sheet,
                                {
                                    backgroundColor: palette.surface,
                                    paddingBottom: Math.max(
                                        spacing.lg,
                                        insets.bottom + spacing.sm,
                                    ),
                                },
                            ]}
                        >
                            <Text
                                style={[
                                    typography.bodyEmphasis,
                                    { color: palette.text },
                                ]}
                            >
                                {sheetRow.parsed.name}
                                {sheetRow.parsed.year !== null
                                    ? ` (${sheetRow.parsed.year})`
                                    : ''}
                            </Text>
                            <Text
                                style={[
                                    typography.caption,
                                    { color: palette.textMuted },
                                ]}
                            >
                                {statusLabel(sheetRow)} · from your export
                            </Text>

                            {sheetBusy ? (
                                <View style={styles.sheetBusy}>
                                    <ActivityIndicator color={palette.accent} />
                                </View>
                            ) : (
                                <>
                                    {(sheetRow.resolution.kind === 'matched' ||
                                        sheetRow.resolution.kind ===
                                            'ambiguous') &&
                                        sheetRow.resolution.candidates.map(
                                            (candidate) => (
                                                <CandidateRow
                                                    key={`${candidate.mediaType}:${candidate.tmdbId}`}
                                                    candidate={candidate}
                                                    selected={
                                                        chosenCandidate(
                                                            sheetRow,
                                                        )?.tmdbId ===
                                                            candidate.tmdbId &&
                                                        chosenCandidate(
                                                            sheetRow,
                                                        )?.mediaType ===
                                                            candidate.mediaType
                                                    }
                                                    palette={palette}
                                                    onPress={() =>
                                                        chooseCandidate(
                                                            sheetRow.parsed.key,
                                                            candidate,
                                                        )
                                                    }
                                                />
                                            ),
                                        )}
                                    {sheetRow.resolution.kind ===
                                        'unmatched' && (
                                        <Text
                                            style={[
                                                typography.caption,
                                                styles.sheetNote,
                                                { color: palette.textMuted },
                                            ]}
                                        >
                                            No TMDB match was found for this
                                            title. It will be skipped unless
                                            you exclude it.
                                        </Text>
                                    )}
                                    {sheetRow.resolution.kind === 'failed' && (
                                        <Pressable
                                            onPress={() =>
                                                void retryRow(
                                                    sheetRow.parsed.key,
                                                )
                                            }
                                            style={({ pressed }) => [
                                                styles.secondaryButton,
                                                styles.sheetAction,
                                                {
                                                    borderColor:
                                                        palette.border,
                                                },
                                                pressed && { opacity: 0.6 },
                                            ]}
                                        >
                                            <Text
                                                style={[
                                                    typography.body,
                                                    { color: palette.text },
                                                ]}
                                            >
                                                Try lookup again
                                            </Text>
                                        </Pressable>
                                    )}
                                    <Pressable
                                        onPress={() => {
                                            updateRow(
                                                sheetRow.parsed.key,
                                                (r) => ({
                                                    ...r,
                                                    excluded: !r.excluded,
                                                }),
                                            );
                                            setSheetKey(null);
                                        }}
                                        style={({ pressed }) => [
                                            styles.secondaryButton,
                                            styles.sheetAction,
                                            { borderColor: palette.border },
                                            pressed && { opacity: 0.6 },
                                        ]}
                                    >
                                        <Text
                                            style={[
                                                typography.body,
                                                {
                                                    color: sheetRow.excluded
                                                        ? palette.text
                                                        : palette.error,
                                                },
                                            ]}
                                        >
                                            {sheetRow.excluded
                                                ? 'Include in import'
                                                : 'Exclude from import'}
                                        </Text>
                                    </Pressable>
                                </>
                            )}
                        </View>
                    )}
                </View>
            </Modal>
        </SafeAreaView>
    );
}

function ProgressBar({
    palette,
    fraction,
}: {
    palette: Palette;
    fraction: number;
}) {
    return (
        <View
            style={[styles.progressTrack, { backgroundColor: palette.surfaceAlt }]}
        >
            <View
                style={[
                    styles.progressFill,
                    {
                        backgroundColor: palette.accent,
                        width: `${Math.round(
                            Math.min(1, Math.max(0, fraction)) * 100,
                        )}%`,
                    },
                ]}
            />
        </View>
    );
}

function PreviewListRow({
    row,
    palette,
    onPress,
}: {
    row: PreviewRow;
    palette: Palette;
    onPress: () => void;
}) {
    const candidate = chosenCandidate(row);
    const title = candidate?.title ?? row.parsed.name;
    const year = candidate?.year ?? row.parsed.year;
    const attention = candidate === null ? attentionLabel(row) : null;
    return (
        <Pressable
            onPress={onPress}
            style={({ pressed }) => [
                styles.previewRow,
                pressed && { opacity: 0.6 },
                row.excluded && { opacity: 0.4 },
            ]}
        >
            {candidate?.posterPath ? (
                <Image
                    source={{ uri: imageUrl(candidate.posterPath, 'w185') }}
                    style={[styles.poster, { backgroundColor: palette.surfaceAlt }]}
                    contentFit="cover"
                    transition={150}
                />
            ) : (
                <View
                    style={[styles.poster, { backgroundColor: palette.surfaceAlt }]}
                />
            )}
            <View style={styles.previewRowText}>
                <Text
                    style={[typography.body, { color: palette.text }]}
                    numberOfLines={1}
                >
                    {title}
                    {year !== null ? `  (${year})` : ''}
                </Text>
                <Text
                    style={[typography.caption, { color: palette.textMuted }]}
                    numberOfLines={1}
                >
                    {statusLabel(row)}
                    {candidate?.mediaType === 'tv' ? ' · TV' : ''}
                </Text>
                {attention !== null && attention.length > 0 && (
                    <Text
                        style={[typography.caption, { color: palette.warning }]}
                        numberOfLines={1}
                    >
                        {attention}
                    </Text>
                )}
            </View>
        </Pressable>
    );
}

function CandidateRow({
    candidate,
    selected,
    palette,
    onPress,
}: {
    candidate: Candidate;
    selected: boolean;
    palette: Palette;
    onPress: () => void;
}) {
    return (
        <Pressable
            onPress={onPress}
            accessibilityRole="button"
            style={({ pressed }) => [
                styles.candidateRow,
                {
                    borderColor: selected ? palette.accent : palette.border,
                    backgroundColor: selected
                        ? palette.accentSubtle
                        : 'transparent',
                },
                pressed && { opacity: 0.6 },
            ]}
        >
            {candidate.posterPath ? (
                <Image
                    source={{ uri: imageUrl(candidate.posterPath, 'w185') }}
                    style={[styles.poster, { backgroundColor: palette.surfaceAlt }]}
                    contentFit="cover"
                    transition={150}
                />
            ) : (
                <View
                    style={[styles.poster, { backgroundColor: palette.surfaceAlt }]}
                />
            )}
            <View style={styles.previewRowText}>
                <Text
                    style={[typography.body, { color: palette.text }]}
                    numberOfLines={2}
                >
                    {candidate.title}
                </Text>
                <Text style={[typography.caption, { color: palette.textMuted }]}>
                    {candidate.year ?? 'Year unknown'}
                    {/* Media label on every candidate: a Letterboxd row
                        can offer a movie and a show with the same
                        title+year, and the label is what tells them
                        apart. */}
                    {candidate.mediaType === 'tv' ? ' · TV show' : ' · Movie'}
                </Text>
            </View>
        </Pressable>
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
    fillCenter: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: spacing.xl,
    },
    progressText: { marginTop: spacing.md },
    progressTrack: {
        width: '100%',
        height: 6,
        borderRadius: radius.full,
        overflow: 'hidden',
    },
    progressFill: {
        height: '100%',
        borderRadius: radius.full,
    },
    errorText: { textAlign: 'center' },
    listContent: {
        paddingHorizontal: spacing.base,
        paddingBottom: spacing.md,
    },
    sectionHeader: {
        paddingTop: spacing.lg,
        paddingBottom: spacing.sm,
    },
    unsupportedNote: { paddingTop: spacing.md },
    previewRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingVertical: spacing.sm,
    },
    previewRowText: { flex: 1, gap: 2 },
    poster: {
        width: POSTER_W,
        height: POSTER_H,
        borderRadius: radius.sm / 2,
    },
    footer: {
        borderTopWidth: StyleSheet.hairlineWidth,
        paddingHorizontal: spacing.base,
        paddingTop: spacing.md,
        gap: spacing.sm,
    },
    primaryButton: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: spacing.md,
        borderRadius: radius.sm,
        minHeight: 48,
    },
    secondaryButton: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: spacing.md,
        paddingHorizontal: spacing.lg,
        borderRadius: radius.sm,
        borderWidth: 1,
        marginTop: spacing.lg,
    },
    doneBody: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: spacing.xl,
    },
    doneCounts: {
        alignItems: 'center',
        marginTop: spacing.md,
        gap: spacing.sm,
    },
    failedList: { textAlign: 'center' },
    doneButton: {
        alignSelf: 'stretch',
        marginTop: spacing.xl,
    },
    sheetScrim: {
        flex: 1,
        justifyContent: 'flex-end',
        backgroundColor: 'rgba(0,0,0,0.5)',
    },
    sheet: {
        borderTopLeftRadius: radius.lg,
        borderTopRightRadius: radius.lg,
        paddingHorizontal: spacing.base,
        paddingTop: spacing.lg,
        gap: spacing.sm,
    },
    sheetBusy: { paddingVertical: spacing.xl, alignItems: 'center' },
    sheetNote: { paddingVertical: spacing.sm },
    sheetAction: { marginTop: spacing.sm },
    candidateRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        padding: spacing.sm,
        borderRadius: radius.sm,
        borderWidth: 1,
        marginTop: spacing.xs,
    },
});
