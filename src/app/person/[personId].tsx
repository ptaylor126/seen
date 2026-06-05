import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { X } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import {
    ActivityIndicator,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    useColorScheme,
    View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import {
    getPerson,
    getPersonCombinedCredits,
    imageUrl,
    type TMDBPersonCredit,
    type TMDBPersonDetail,
} from '@/lib/tmdb';
import {
    getPalette,
    ICON_STROKE_WIDTH,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

// Layout constants — kept local because they're only used here. The
// poster grid is two columns to give every title a decent tap target
// without paging through endless rows. Aspect ratio matches TMDB
// poster shape (2:3).
const PROFILE_SIZE = 120;
const POSTER_ASPECT = 2 / 3;

// Sections rendered (in this order). Acting is sourced from `cast`;
// Director / Writer are sourced from `crew` filtered by `job`. Producer
// is intentionally omitted for v1 per scope — adding it later is a
// one-line change here.
type Department = 'acting' | 'directing' | 'writing';

const DEPARTMENT_HEADINGS: Record<Department, string> = {
    acting: 'AS ACTOR',
    directing: 'AS DIRECTOR',
    writing: 'AS WRITER',
};

// Pull the displayable date out of a credit (TMDB uses different
// field names per media type) and reduce to the year prefix used for
// sorting + display.
function creditYear(credit: TMDBPersonCredit): string {
    const raw =
        credit.media_type === 'movie' ? credit.release_date : credit.first_air_date;
    return raw ? raw.slice(0, 4) : '';
}

function creditTitle(credit: TMDBPersonCredit): string {
    return (credit.media_type === 'movie' ? credit.title : credit.name) ?? '';
}

// Sort by release date desc. Credits without any date sink to the
// bottom — those are usually unreleased / unannounced projects with
// little for the user to act on, and we don't want them above the
// hits.
function sortByRecency(a: TMDBPersonCredit, b: TMDBPersonCredit): number {
    const ay = creditYear(a);
    const by = creditYear(b);
    if (ay === by) return 0;
    if (!ay) return 1;
    if (!by) return -1;
    return by.localeCompare(ay);
}

// De-dupe credits by (media_type, id). Crew filmographies repeat the
// same title once per job (a "Director" credit and a "Writer" credit
// on the same film land in their respective sections — that's fine —
// but within a single section the same id can appear twice when
// someone is credited under multiple job aliases). One row per title
// per section.
function dedupeCredits(credits: TMDBPersonCredit[]): TMDBPersonCredit[] {
    const seen = new Set<string>();
    const out: TMDBPersonCredit[] = [];
    for (const c of credits) {
        const key = `${c.media_type}-${c.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(c);
    }
    return out;
}

export default function PersonScreen() {
    const params = useLocalSearchParams<{ personId: string }>();
    const router = useRouter();
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const insets = useSafeAreaInsets();

    const personIdRaw = typeof params.personId === 'string' ? params.personId : '';
    const personId = Number.parseInt(personIdRaw, 10);

    const [detail, setDetail] = useState<TMDBPersonDetail | null>(null);
    const [sections, setSections] = useState<
        Record<Department, TMDBPersonCredit[]>
    >({ acting: [], directing: [], writing: [] });
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!Number.isFinite(personId)) {
            setError('Invalid person');
            setLoading(false);
            return;
        }
        let active = true;
        (async () => {
            try {
                const [person, credits] = await Promise.all([
                    getPerson(personId),
                    getPersonCombinedCredits(personId),
                ]);
                if (!active) return;

                // Drop poster-less rows from every section. A missing
                // poster usually means the title is too obscure or too
                // unreleased to render meaningfully in a poster grid.
                const acting = dedupeCredits(
                    credits.cast.filter((c) => !!c.poster_path),
                ).sort(sortByRecency);

                const crewWithPosters = credits.crew.filter(
                    (c) => !!c.poster_path,
                );
                const directing = dedupeCredits(
                    crewWithPosters.filter((c) => c.job === 'Director'),
                ).sort(sortByRecency);
                const writing = dedupeCredits(
                    crewWithPosters.filter((c) => c.job === 'Writer'),
                ).sort(sortByRecency);

                setDetail(person);
                setSections({ acting, directing, writing });
            } catch (err) {
                if (!active) return;
                setError(
                    err instanceof Error ? err.message : 'Failed to load person',
                );
            } finally {
                if (active) setLoading(false);
            }
        })();
        return () => {
            active = false;
        };
    }, [personId]);

    const openCredit = (credit: TMDBPersonCredit) => {
        router.push({
            pathname: '/title/[mediaType]/[tmdbId]',
            params: {
                mediaType: credit.media_type,
                tmdbId: String(credit.id),
            },
        });
    };

    return (
        <View style={[styles.screen, { backgroundColor: palette.bg }]}>
            <Pressable
                onPress={() => router.back()}
                hitSlop={spacing.sm}
                accessibilityRole="button"
                accessibilityLabel="Close"
                style={[
                    styles.closeButton,
                    {
                        top: spacing.base,
                        backgroundColor: palette.surface,
                    },
                ]}
            >
                <X color={palette.text} size={20} strokeWidth={ICON_STROKE_WIDTH} />
            </Pressable>

            {loading ? (
                <View style={styles.centered}>
                    <ActivityIndicator color={palette.accent} />
                </View>
            ) : error || !detail ? (
                <View style={styles.centered}>
                    <Text style={[typography.body, { color: palette.textMuted }]}>
                        {error ?? 'Person not found'}
                    </Text>
                </View>
            ) : (
                <ScrollView
                    contentContainerStyle={[
                        styles.scrollContent,
                        { paddingBottom: insets.bottom + spacing.xl },
                    ]}
                    showsVerticalScrollIndicator={false}
                >
                    <View style={styles.profileBlock}>
                        {detail.profile_path ? (
                            <Image
                                source={{ uri: imageUrl(detail.profile_path, 'w342') }}
                                style={styles.profileImage}
                                contentFit="cover"
                                transition={150}
                            />
                        ) : (
                            <Avatar
                                avatarUrl={null}
                                displayName={detail.name}
                                seedId={String(detail.id)}
                                size={PROFILE_SIZE}
                            />
                        )}
                        <Text
                            style={[
                                typography.display,
                                styles.name,
                                { color: palette.text },
                            ]}
                        >
                            {detail.name}
                        </Text>
                        {detail.known_for_department ? (
                            <Text
                                style={[
                                    typography.caption,
                                    { color: palette.textMuted },
                                ]}
                            >
                                Known for {detail.known_for_department.toLowerCase()}
                            </Text>
                        ) : null}
                    </View>

                    {(['acting', 'directing', 'writing'] as Department[]).map(
                        (dept) => {
                            const credits = sections[dept];
                            if (credits.length === 0) return null;
                            return (
                                <View key={dept} style={styles.section}>
                                    <Text
                                        style={[
                                            typography.micro,
                                            styles.sectionHeading,
                                            { color: palette.textMuted },
                                        ]}
                                    >
                                        {DEPARTMENT_HEADINGS[dept]}
                                    </Text>
                                    <View style={styles.grid}>
                                        {credits.map((credit) => (
                                            <CreditCard
                                                key={`${credit.media_type}-${credit.id}`}
                                                credit={credit}
                                                onPress={() => openCredit(credit)}
                                            />
                                        ))}
                                    </View>
                                </View>
                            );
                        },
                    )}
                </ScrollView>
            )}
        </View>
    );
}

function CreditCard({
    credit,
    onPress,
}: {
    credit: TMDBPersonCredit;
    onPress: () => void;
}) {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const title = creditTitle(credit);
    const year = creditYear(credit);
    // poster_path is guaranteed non-null here because the loader
    // filters poster-less rows before rendering.
    const poster = credit.poster_path ?? '';

    return (
        <Pressable
            onPress={onPress}
            style={({ pressed }) => [styles.card, pressed && { opacity: 0.6 }]}
        >
            <Image
                source={{ uri: imageUrl(poster, 'w342') }}
                style={[
                    styles.poster,
                    { backgroundColor: palette.surface },
                ]}
                contentFit="cover"
                transition={150}
            />
            <Text
                style={[typography.bodyEmphasis, { color: palette.text }]}
                numberOfLines={2}
            >
                {title}
            </Text>
            {year ? (
                <Text style={[typography.caption, { color: palette.textMuted }]}>
                    {year}
                </Text>
            ) : null}
        </Pressable>
    );
}

const CARD_GAP = spacing.base;

const styles = StyleSheet.create({
    screen: { flex: 1 },
    centered: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: spacing.xl,
    },
    closeButton: {
        position: 'absolute',
        right: spacing.base,
        width: 36,
        height: 36,
        borderRadius: radius.full,
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10,
    },
    scrollContent: {
        paddingHorizontal: spacing.base,
        paddingTop: spacing.xxl,
    },
    profileBlock: {
        alignItems: 'center',
        gap: spacing.sm,
        paddingBottom: spacing.xl,
    },
    profileImage: {
        width: PROFILE_SIZE,
        height: PROFILE_SIZE,
        borderRadius: PROFILE_SIZE / 2,
    },
    name: {
        textAlign: 'center',
    },
    section: {
        paddingTop: spacing.lg,
        gap: spacing.md,
    },
    sectionHeading: {
        letterSpacing: 1.2,
    },
    grid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: CARD_GAP,
    },
    card: {
        // Two columns: the parent provides spacing.base horizontal
        // padding on each edge; CARD_GAP separates the two columns.
        // width = (100% - gap) / 2 — encoded via flexBasis so the
        // gap accounting stays correct at any container width.
        flexBasis: `48%` as const,
        flexGrow: 0,
        gap: spacing.xs,
    },
    poster: {
        width: '100%',
        aspectRatio: POSTER_ASPECT,
        borderRadius: radius.sm,
    },
});
