import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { MessageCircle } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import {
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    useColorScheme,
    View,
} from 'react-native';

import { relativeTimestamp } from '@/components/thread/shared';
import type { MediaType } from '@/lib/rating';
import supabase from '@/lib/supabase';
import { fetchTitlesWithFallback } from '@/lib/titles';
import { imageUrl } from '@/lib/tmdb';
import {
    POSTER_STRIP_GAP,
    POSTER_STRIP_H,
    POSTER_STRIP_INSET,
    POSTER_STRIP_W,
} from '@/theme/poster-layout';
import {
    getPalette,
    ICON_STROKE_WIDTH,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

// Strip layout (poster dimensions, inset, gap) comes from the shared
// @/theme/poster-layout module — ONE definition, identical to the "Recs
// between you" strip on the friend profile.

// One title's chats between the pair. Because the query is last_activity-desc
// and Map preserves insertion order, the FIRST row per title is its most-
// recently-active chat, so targetChatId / lastActivity come from it and the
// groups already iterate newest-first — no re-sort.
interface ChatGroup {
    key: string;
    tmdbId: number;
    mediaType: MediaType;
    posterPath: string | null;
    title: string;
    // The most-recently-active chat for this title (whole-show OR episode) —
    // tapping the row resumes THIS conversation, not necessarily the
    // whole-show one.
    targetChatId: string;
    lastActivity: string;
    // How many chats exist for this title with this friend (whole-show +
    // episode chats). >1 shows the conversations pill.
    count: number;
}

// Chats between the current user and one friend, grouped by title, most
// recently active first. Self-contained (owns its query + title resolution +
// render) so a future standalone chats screen can adopt it. Renders nothing
// when there are no chats. Two-party by construction and by RLS
// (title_chats_select_party); no exposure of the friend's other chats.
export function ChatsBetweenSection({
    friendId,
    friendName,
    bandColor,
}: {
    friendId: string;
    friendName: string;
    // Full-width background band the section paints behind itself, so the
    // friend profile's alternating-band rhythm applies here without the
    // parent needing to know (async) whether this section renders. Applied
    // to the section root ONLY when the section actually renders (it returns
    // null when there are no chats), so no empty coloured band is left
    // behind. The parent also owns the vertical rhythm via bandVertical
    // padding here — the section carries no outer margin of its own.
    bandColor?: string;
}) {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const router = useRouter();
    const [groups, setGroups] = useState<ChatGroup[] | null>(null);

    useEffect(() => {
        let active = true;
        (async () => {
            try {
                const {
                    data: { session },
                } = await supabase.auth.getSession();
                const me = session?.user.id;
                if (!me || !active) return;

                const { data, error } = await supabase
                    .from('title_chats')
                    .select(
                        'id, from_user_id, to_user_id, tmdb_id, media_type, season, episode, last_activity',
                    )
                    .or(
                        `and(from_user_id.eq.${me},to_user_id.eq.${friendId}),and(from_user_id.eq.${friendId},to_user_id.eq.${me})`,
                    )
                    .order('last_activity', { ascending: false });
                if (error) throw error;
                if (!active) return;

                const rows = data ?? [];
                if (rows.length === 0) {
                    setGroups([]);
                    return;
                }

                // Group by title. Rows are last_activity-desc, so the first
                // row seen for a key is that title's newest chat.
                const byKey = new Map<
                    string,
                    {
                        tmdbId: number;
                        mediaType: MediaType;
                        targetChatId: string;
                        lastActivity: string;
                        count: number;
                    }
                >();
                for (const r of rows) {
                    if (r.media_type !== 'movie' && r.media_type !== 'tv') {
                        continue;
                    }
                    const key = `${r.media_type}:${r.tmdb_id}`;
                    const existing = byKey.get(key);
                    if (!existing) {
                        byKey.set(key, {
                            tmdbId: r.tmdb_id,
                            mediaType: r.media_type as MediaType,
                            targetChatId: r.id,
                            lastActivity: r.last_activity,
                            count: 1,
                        });
                    } else {
                        existing.count += 1;
                    }
                }

                // One batched title lookup (catalogue + TMDB fallback).
                const titleByKey = await fetchTitlesWithFallback(
                    Array.from(byKey.values()).map((g) => ({
                        tmdb_id: g.tmdbId,
                        media_type: g.mediaType,
                    })),
                );
                if (!active) return;

                const built: ChatGroup[] = Array.from(byKey.entries()).map(
                    ([key, g]) => ({
                        key,
                        tmdbId: g.tmdbId,
                        mediaType: g.mediaType,
                        posterPath: titleByKey.get(key)?.poster_path ?? null,
                        title: titleByKey.get(key)?.title ?? 'this title',
                        targetChatId: g.targetChatId,
                        lastActivity: g.lastActivity,
                        count: g.count,
                    }),
                );
                if (active) setGroups(built);
            } catch (err) {
                console.warn('chats-between fetch failed:', err);
            }
        })();
        return () => {
            active = false;
        };
    }, [friendId]);

    if (!groups || groups.length === 0) return null;

    return (
        <View
            style={[
                styles.section,
                bandColor ? { backgroundColor: bandColor } : null,
            ]}
        >
            <Text style={[typography.overline, { color: palette.textMuted }]}>
                Chats between you
            </Text>
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.scroll}
                contentContainerStyle={styles.scrollContent}
            >
                {groups.map((g) => {
                    const lastActive = relativeTimestamp(g.lastActivity);
                    return (
                        <Pressable
                            key={g.key}
                            onPress={() =>
                                router.push(`/chat/${g.targetChatId}`)
                            }
                            style={({ pressed }) => [
                                styles.card,
                                pressed && { opacity: 0.6 },
                            ]}
                            accessibilityRole="button"
                            accessibilityLabel={
                                g.count > 1
                                    ? `Chat with ${friendName} about ${g.title}, ${g.count} conversations, last active ${lastActive}`
                                    : `Chat with ${friendName} about ${g.title}, last active ${lastActive}`
                            }
                        >
                            <View
                                style={[
                                    styles.posterWrap,
                                    { backgroundColor: palette.surfaceAlt },
                                ]}
                            >
                                {g.posterPath ? (
                                    <Image
                                        source={{
                                            uri: imageUrl(g.posterPath, 'w185'),
                                        }}
                                        style={styles.poster}
                                        contentFit="cover"
                                        transition={150}
                                    />
                                ) : null}
                                {/* Conversations count — muted dark chip +
                                    chat glyph, bottom-left, reading as "N
                                    conversations" (metadata), NOT an unread
                                    badge (accent, top-right). Only when >1. */}
                                {g.count > 1 ? (
                                    <View style={styles.countPill}>
                                        <MessageCircle
                                            color="#FFFFFF"
                                            size={11}
                                            strokeWidth={ICON_STROKE_WIDTH}
                                        />
                                        <Text
                                            style={[
                                                typography.micro,
                                                styles.countText,
                                            ]}
                                        >
                                            {g.count}
                                        </Text>
                                    </View>
                                ) : null}
                            </View>
                            <Text
                                style={[
                                    typography.micro,
                                    { color: palette.textMuted },
                                ]}
                                numberOfLines={1}
                            >
                                {lastActive}
                            </Text>
                        </Pressable>
                    );
                })}
            </ScrollView>
        </View>
    );
}

const styles = StyleSheet.create({
    section: {
        // Vertical rhythm is owned by the band (paddingVertical base = 16),
        // matching the friend profile's other section bands so the gap
        // between any two sections is a uniform 32 (16 + 16) and can't
        // accumulate — the section carries no outer margin. Horizontal
        // padding insets the heading; the strip below bleeds past it.
        paddingHorizontal: spacing.base,
        paddingVertical: spacing.base,
        gap: spacing.sm,
    },
    scroll: {
        marginHorizontal: -POSTER_STRIP_INSET,
    },
    scrollContent: {
        paddingHorizontal: POSTER_STRIP_INSET,
        gap: POSTER_STRIP_GAP,
    },
    card: {
        width: POSTER_STRIP_W,
        gap: spacing.xs,
    },
    posterWrap: {
        width: POSTER_STRIP_W,
        height: POSTER_STRIP_H,
        borderRadius: radius.sm,
        overflow: 'hidden',
    },
    poster: {
        width: '100%',
        height: '100%',
    },
    countPill: {
        position: 'absolute',
        left: 4,
        bottom: 4,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 3,
        paddingHorizontal: 5,
        paddingVertical: 2,
        borderRadius: radius.sm,
        backgroundColor: 'rgba(0, 0, 0, 0.6)',
    },
    countText: {
        color: '#FFFFFF',
    },
});
