import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Check, Search as SearchIcon, X } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Keyboard,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    useColorScheme,
    View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { useKeyboard } from '@/hooks/use-keyboard-open';
import supabase from '@/lib/supabase';
import { ensureTitle, type EnsureTitleArgs } from '@/lib/titles';
import { getMovie, getTV, imageUrl, type TMDBMovie, type TMDBTV } from '@/lib/tmdb';
import {
    getPalette,
    ICON_STROKE_WIDTH,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

type MediaType = 'movie' | 'tv';

interface FriendRow {
    userId: string;
    handle: string;
    displayName: string;
    avatarUrl: string | null;
}

interface TitleContext {
    title: string;
    posterPath: string | null;
}

const NOTE_MAX_LENGTH = 500;
const FRIEND_AVATAR_SIZE = 44;
const POSTER_W = 40;
const POSTER_H = 60;

export default function RecommendScreen() {
    const params = useLocalSearchParams<{
        mediaType: string;
        tmdbId: string;
        // Pre-selected recipient id, forwarded by /library/add when the
        // user entered the recommend flow from a friend profile.
        preselect?: string;
    }>();
    const router = useRouter();
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const insets = useSafeAreaInsets();
    // Bottom bar floats above the keyboard via the KeyboardAvoidingView,
    // but we still toggle its own paddingBottom on open/close so the
    // home-indicator inset doesn't leave a 34px gap above the keyboard
    // when it rises.
    const keyboard = useKeyboard();

    const mediaType: MediaType | null =
        params.mediaType === 'movie' || params.mediaType === 'tv'
            ? (params.mediaType as MediaType)
            : null;
    const tmdbIdRaw = typeof params.tmdbId === 'string' ? params.tmdbId : '';
    const tmdbId = Number.parseInt(tmdbIdRaw, 10);
    const preselectedFriendId =
        typeof params.preselect === 'string' && params.preselect.length > 0
            ? params.preselect
            : null;

    const [titleCtx, setTitleCtx] = useState<TitleContext | null>(null);
    // Full catalogue metadata for the title, captured at load so the send
    // can stamp public.titles via ensureTitle (send_recommendation doesn't
    // stamp it server-side). null until the TMDB detail resolves.
    const [titleStamp, setTitleStamp] = useState<EnsureTitleArgs | null>(null);
    const [friends, setFriends] = useState<FriendRow[]>([]);
    // Initial state seeds from the preselect param so the recipient is
    // pre-checked when arriving from the friend-profile recommend flow.
    // We never re-apply it after mount — once the user picks, they own
    // the selection. Set rather than scalar so the user can pick several
    // recipients and send to all of them with a single tap of Send.
    const [selectedFriendIds, setSelectedFriendIds] = useState<Set<string>>(
        () =>
            preselectedFriendId
                ? new Set([preselectedFriendId])
                : new Set<string>(),
    );
    const [note, setNote] = useState('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [sending, setSending] = useState(false);
    // Local recipient filter — mirrors the Friends tab / library local
    // search (borderless surface pill, inline clear-X, Cancel-on-focus).
    // Filters the rendered list only; selectedFriendIds is independent, so
    // selection survives filtering and clearing.
    const [localQuery, setLocalQuery] = useState('');
    const [localFocused, setLocalFocused] = useState(false);
    const localSearchInputRef = useRef<TextInput | null>(null);

    useEffect(() => {
        if (!mediaType || !Number.isFinite(tmdbId)) {
            setError('Invalid title');
            setLoading(false);
            return;
        }
        let active = true;

        // Resolve the full catalogue metadata (not just title + poster) so
        // the same fetch feeds both the header display and the send-time
        // ensureTitle stamp. Mirrors the title screen's getMovie/getTV →
        // ensureTitle mapping (empty TMDB date → null, genres → genre ids).
        const titlePromise: Promise<EnsureTitleArgs> =
            mediaType === 'movie'
                ? getMovie(tmdbId).then((m: TMDBMovie) => ({
                      tmdbId,
                      mediaType: 'movie' as const,
                      title: m.title,
                      posterPath: m.poster_path,
                      backdropPath: m.backdrop_path,
                      releaseDate:
                          m.release_date && m.release_date.length > 0
                              ? m.release_date
                              : null,
                      originalLanguage: m.original_language,
                      genreIds: m.genres.map((g) => g.id),
                  }))
                : getTV(tmdbId).then((t: TMDBTV) => ({
                      tmdbId,
                      mediaType: 'tv' as const,
                      title: t.name,
                      posterPath: t.poster_path,
                      backdropPath: t.backdrop_path,
                      releaseDate:
                          t.first_air_date && t.first_air_date.length > 0
                              ? t.first_air_date
                              : null,
                      originalLanguage: t.original_language,
                      genreIds: t.genres.map((g) => g.id),
                  }));

        (async () => {
            try {
                const [resolvedTitle, sessionResult] = await Promise.all([
                    titlePromise,
                    supabase.auth.getSession(),
                ]);
                if (!active) return;
                setTitleCtx({
                    title: resolvedTitle.title,
                    posterPath: resolvedTitle.posterPath,
                });
                setTitleStamp(resolvedTitle);

                const userId = sessionResult.data.session?.user.id;
                if (!userId) throw new Error('Not authenticated');

                // Same lexicographic OR-match used by the friends tab; we
                // pick the other party per row and batch the profile
                // lookups by id.
                const { data: friendships, error: friendshipsError } = await supabase
                    .from('friendships')
                    .select('user_a_id, user_b_id')
                    .or(`user_a_id.eq.${userId},user_b_id.eq.${userId}`);
                if (friendshipsError) throw friendshipsError;
                if (!active) return;

                const otherIds = (friendships ?? []).map((f) =>
                    f.user_a_id === userId ? f.user_b_id : f.user_a_id,
                );

                if (otherIds.length === 0) {
                    setFriends([]);
                    return;
                }

                const [
                    { data: profiles, error: profilesError },
                    { data: sentRecs, error: sentRecsError },
                ] = await Promise.all([
                    supabase
                        .from('profiles')
                        .select('id, handle, display_name, avatar_url')
                        .in('id', otherIds),
                    // Recency ranking input: every rec the current user has
                    // SENT, newest first. We only need (recipient, sent_at);
                    // the first row seen per recipient is their most recent.
                    supabase
                        .from('recommendations')
                        .select('to_user_id, sent_at')
                        .eq('from_user_id', userId)
                        .order('sent_at', { ascending: false }),
                ]);
                if (profilesError) throw profilesError;
                if (sentRecsError) throw sentRecsError;
                if (!active) return;

                // Friend id -> most-recent sent_at. Query is already sorted
                // newest-first, so the first hit per recipient wins.
                const lastSentTo = new Map<string, string>();
                for (const r of sentRecs ?? []) {
                    if (r.to_user_id && r.sent_at && !lastSentTo.has(r.to_user_id)) {
                        lastSentTo.set(r.to_user_id, r.sent_at);
                    }
                }

                const rows: FriendRow[] = (profiles ?? []).map((p) => ({
                    userId: p.id,
                    handle: p.handle,
                    displayName: p.display_name,
                    avatarUrl: p.avatar_url,
                }));

                // Reorder (never filter): friends you've sent to most recently
                // rise to the top by sent_at desc; everyone you've never sent
                // to falls below, alphabetical by name for a stable order. ISO
                // timestamps compare correctly as strings.
                rows.sort((a, b) => {
                    const aSent = lastSentTo.get(a.userId);
                    const bSent = lastSentTo.get(b.userId);
                    if (aSent && bSent) {
                        return aSent < bSent ? 1 : aSent > bSent ? -1 : 0;
                    }
                    if (aSent) return -1;
                    if (bSent) return 1;
                    return a.displayName.localeCompare(b.displayName);
                });

                setFriends(rows);
            } catch (err) {
                if (!active) return;
                console.error('recommend init failed:', err);
                setError(err instanceof Error ? err.message : 'Failed to load');
            } finally {
                if (active) setLoading(false);
            }
        })();

        return () => {
            active = false;
        };
    }, [mediaType, tmdbId]);

    const trimmedNote = note.trim();
    const selectedCount = selectedFriendIds.size;
    const canSend =
        !sending && selectedCount > 0 && mediaType !== null && !loading;

    // Case-insensitive match against display name AND @handle (haystack
    // includes "@" so typing it or omitting it both work). Filtering
    // preserves the recency order already baked into `friends`.
    const normalizedQuery = localQuery.trim().toLowerCase();
    const filteredFriends =
        normalizedQuery.length === 0
            ? friends
            : friends.filter((f) =>
                  `${f.displayName} @${f.handle}`
                      .toLowerCase()
                      .includes(normalizedQuery),
              );

    function toggleFriend(userId: string) {
        setSelectedFriendIds((prev) => {
            const next = new Set(prev);
            if (next.has(userId)) {
                next.delete(userId);
            } else {
                next.add(userId);
            }
            return next;
        });
    }

    // Recipient id -> display name for user-facing copy.
    function displayNameFor(id: string) {
        return friends.find((f) => f.userId === id)?.displayName ?? 'a friend';
    }

    // Gentle, sentence-case heads-up line for a recipient who already has
    // this title in their (friends-visible) library.
    function alreadyHasLine(name: string, status: string): string {
        switch (status) {
            case 'watched':
                return `${name} has already watched this.`;
            case 'watching':
                return `${name} is already watching this.`;
            case 'watchlist':
                return `It's already on ${name}'s watchlist.`;
            default:
                return `${name} already has this in their library.`;
        }
    }

    // Promise-wrapped Alert so handleSend can await the sender's choice.
    // Non-blocking by design: "Send anyway" is always offered — this is
    // information, not a restriction.
    function confirmSendAnyway(message: string): Promise<boolean> {
        return new Promise((resolve) => {
            Alert.alert('Heads up', message, [
                { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
                { text: 'Send anyway', onPress: () => resolve(true) },
            ]);
        });
    }

    async function handleSend() {
        if (!canSend || !mediaType) return;
        setSending(true);
        const recipientIds = Array.from(selectedFriendIds);
        try {
            // Privacy-safe heads-up. RLS on items (is_item_visible_to_auth)
            // returns a row ONLY when it's friends-visible — visibility =
            // 'friends' AND we're a confirmed friend. A PRIVATE item returns
            // nothing here, indistinguishable from "no item", so the sender
            // can never infer a hidden library entry. The privacy gate is
            // enforced by the database, not by this query.
            const { data: visibleItems, error: itemsError } = await supabase
                .from('items')
                .select('user_id, status')
                .in('user_id', recipientIds)
                .eq('tmdb_id', tmdbId)
                .eq('media_type', mediaType);
            if (itemsError) throw itemsError;

            if (visibleItems && visibleItems.length > 0) {
                // One line per already-has recipient, ordered by the picker
                // for stable copy. Recipients with no (visible) item are
                // silently absent — no "they haven't seen it" signal.
                const message = recipientIds
                    .map((id) => {
                        const hit = visibleItems.find((it) => it.user_id === id);
                        return hit
                            ? alreadyHasLine(displayNameFor(id), hit.status)
                            : null;
                    })
                    .filter((line): line is string => line !== null)
                    .join('\n');
                const proceed = await confirmSendAnyway(message);
                if (!proceed) {
                    setSending(false);
                    return;
                }
            }

            await performSend(recipientIds, mediaType);
        } catch (err) {
            console.error('send recommendation failed:', err);
            surfaceError(err, "Couldn't send");
            setSending(false);
        }
    }

    async function performSend(recipientIds: string[], mt: MediaType) {
        try {
            // Stamp the title into public.titles so it's catalogued for the
            // recipient's home/inbox render (send_recommendation doesn't do
            // this server-side). Fire-and-forget — ensureTitle swallows its
            // own failures (titles.ts), and the home screen has its own
            // TMDB fallback, so a missed stamp never blocks the send.
            if (titleStamp) void ensureTitle(titleStamp);

            // Fan out to all recipients in parallel via the existing
            // single-recipient RPC. allSettled (not Promise.all) so one
            // bad recipient doesn't abort the rest — each rec is its own
            // row and its own rec_received notification through the
            // existing trigger path, so partial success is meaningful.
            const results = await Promise.allSettled(
                recipientIds.map((toId) =>
                    supabase.rpc('send_recommendation', {
                        to_user_id: toId,
                        tmdb_id: tmdbId,
                        media_type: mt,
                        note: trimmedNote.length > 0 ? trimmedNote : undefined,
                    }),
                ),
            );

            const nameFor = displayNameFor;
            const sent: string[] = [];
            const alreadySent: string[] = [];
            const failed: { name: string; message: string }[] = [];

            results.forEach((result, i) => {
                const toId = recipientIds[i];
                const name = nameFor(toId);
                if (result.status === 'rejected') {
                    // Network-level rejection (the supabase-js call never
                    // resolved). Rare but possible on offline.
                    failed.push({
                        name,
                        message:
                            result.reason instanceof Error
                                ? result.reason.message
                                : String(result.reason),
                    });
                    return;
                }
                // Fulfilled: supabase.rpc resolves with { data, error }
                // — the RPC error lives in result.value.error, not a
                // rejected promise.
                const rpcError = result.value.error;
                if (!rpcError) {
                    sent.push(name);
                    return;
                }
                // 23505 = unique_violation on recommendations_pair_unique
                // (from_user_id, to_user_id, tmdb_id, media_type). Means
                // the user already recommended this exact title to this
                // exact friend at some point — and recs are immutable on
                // the sender side, so we leave the existing one alone
                // and report it as a benign no-op rather than a failure.
                if (rpcError.code === '23505') {
                    alreadySent.push(name);
                    return;
                }
                failed.push({ name, message: rpcError.message });
            });

            // Build one summary message that names which recipients
            // landed in which bucket. Title flips to "Partially sent" /
            // "Couldn't send" if anything actually failed.
            const lines: string[] = [];
            if (sent.length > 0) {
                lines.push(
                    sent.length === 1
                        ? `Sent to ${sent[0]}.`
                        : `Sent to ${sent.length} friends: ${sent.join(', ')}.`,
                );
            }
            if (alreadySent.length > 0) {
                lines.push(
                    alreadySent.length === 1
                        ? `${alreadySent[0]} already had this rec — left as-is.`
                        : `Already recommended to ${alreadySent.join(', ')} — left as-is.`,
                );
            }
            if (failed.length > 0) {
                lines.push(
                    `Couldn't send to ${failed.map((f) => f.name).join(', ')}.`,
                );
            }

            const anySuccess = sent.length > 0 || alreadySent.length > 0;
            const alertTitle =
                failed.length === 0
                    ? 'Sent'
                    : anySuccess
                      ? 'Partially sent'
                      : "Couldn't send";

            Alert.alert(alertTitle, lines.join('\n\n'), [
                {
                    text: 'OK',
                    onPress: () => {
                        // Only pop back if at least one rec actually
                        // landed; if every recipient failed, leave the
                        // modal up so the user can retry.
                        if (anySuccess) router.back();
                    },
                },
            ]);
        } catch (err) {
            console.error('send recommendation failed:', err);
            surfaceError(err, "Couldn't send");
        } finally {
            setSending(false);
        }
    }

    function renderAvatar(row: FriendRow) {
        if (row.avatarUrl) {
            return (
                <Image
                    source={{ uri: row.avatarUrl }}
                    style={[styles.avatar, { backgroundColor: palette.accent }]}
                    contentFit="cover"
                    transition={150}
                />
            );
        }
        const letter = row.displayName[0]?.toUpperCase() ?? '?';
        return (
            <View
                style={[
                    styles.avatar,
                    styles.avatarFallback,
                    { backgroundColor: palette.accent },
                ]}
            >
                <Text
                    style={[typography.bodyEmphasis, { color: palette.textInverse }]}
                >
                    {letter}
                </Text>
            </View>
        );
    }

    function renderFriendRow(row: FriendRow) {
        const isSelected = selectedFriendIds.has(row.userId);
        return (
            <Pressable
                key={row.userId}
                onPress={() => toggleFriend(row.userId)}
                style={({ pressed }) => [
                    styles.friendRow,
                    isSelected && { backgroundColor: palette.accentSubtle },
                    pressed && { opacity: 0.6 },
                ]}
            >
                {renderAvatar(row)}
                <View style={styles.friendText}>
                    <Text
                        style={[typography.bodyEmphasis, { color: palette.text }]}
                        numberOfLines={1}
                    >
                        {row.displayName}
                    </Text>
                    <Text style={[typography.caption, { color: palette.textMuted }]}>
                        @{row.handle}
                    </Text>
                </View>
                <View
                    style={[
                        styles.checkCircle,
                        {
                            borderColor: isSelected ? palette.accent : palette.border,
                            backgroundColor: isSelected
                                ? palette.accent
                                : 'transparent',
                        },
                    ]}
                >
                    {isSelected && (
                        <Check
                            color={palette.textInverse}
                            size={16}
                            strokeWidth={ICON_STROKE_WIDTH}
                        />
                    )}
                </View>
            </Pressable>
        );
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
                    <Text style={[typography.body, { color: palette.accent }]}>
                        Cancel
                    </Text>
                </Pressable>
                <Text style={[typography.heading, { color: palette.text }]}>
                    Recommend
                </Text>
                {/* Send lives in the header (top-right, opposite Cancel)
                    rather than the pinned bottom bar — the header never
                    moves with the keyboard, so Send is always reachable
                    while typing the note. Same canSend gate as before
                    (at least one friend selected). Label keeps the
                    recipient count so multi-friend selection stays
                    visually obvious; spinner replaces the label while
                    the send fan-out is in flight. */}
                <Pressable
                    onPress={handleSend}
                    disabled={!canSend}
                    hitSlop={spacing.sm}
                    accessibilityRole="button"
                    accessibilityLabel={
                        selectedCount === 0
                            ? 'Send'
                            : `Send to ${selectedCount}`
                    }
                    style={({ pressed }) => [
                        pressed && { opacity: 0.6 },
                        !canSend && { opacity: 0.4 },
                    ]}
                >
                    {sending ? (
                        <ActivityIndicator color={palette.accent} />
                    ) : (
                        <Text
                            style={[
                                typography.bodyEmphasis,
                                { color: palette.accent },
                            ]}
                        >
                            {selectedCount === 0
                                ? 'Send'
                                : `Send to ${selectedCount}`}
                        </Text>
                    )}
                </Pressable>
            </View>

            {/* No KeyboardAvoidingView. KAV's 'padding' behavior was
                only partially lifting the note field above the
                keyboard — the multiline TextInput could grow as the
                user typed, and KAV's indirect padding calculation
                didn't always land the bar fully above the keyboard.
                Now that Send moved to the header (the part that has
                to be reachable while typing), we only need to lift
                the note field + char counter, which we do directly:
                the bar's marginBottom = keyboard.height on iOS when
                the keyboard is open, so the bar's outer bottom sits
                exactly at the keyboard's top. On Android the
                manifest's windowSoftInputMode=adjustResize shrinks
                the window when the keyboard rises, which keeps the
                bar at the (now-shorter) screen bottom — no manual
                marginBottom needed. */}
            <View style={styles.flex}>
                <ScrollView
                    style={styles.flex}
                    keyboardShouldPersistTaps="handled"
                    keyboardDismissMode="on-drag"
                    contentContainerStyle={styles.scrollContent}
                >
                    {/* Pressable wraps the scroll contents so taps on the
                        background (title context, "SEND TO" label, gaps
                        around friend rows) dismiss the keyboard. Friend
                        rows are themselves Pressables and capture their
                        own taps before the wrapper sees them, so
                        selection still works. Dragging the friend list
                        also dismisses via keyboardDismissMode above. */}
                    <Pressable
                        onPress={() => Keyboard.dismiss()}
                        accessibilityElementsHidden
                        importantForAccessibility="no-hide-descendants"
                    >
                    {/* Title context — keeps the modal grounded in what's
                        being recommended without needing to scroll back. */}
                    {titleCtx && (
                        <View style={styles.titleContext}>
                            {titleCtx.posterPath ? (
                                <Image
                                    source={{
                                        uri: imageUrl(titleCtx.posterPath, 'w185'),
                                    }}
                                    style={styles.contextPoster}
                                    contentFit="cover"
                                    transition={150}
                                />
                            ) : (
                                <View
                                    style={[
                                        styles.contextPoster,
                                        { backgroundColor: palette.surfaceAlt },
                                    ]}
                                />
                            )}
                            <Text
                                style={[
                                    typography.bodyEmphasis,
                                    styles.contextTitle,
                                    { color: palette.text },
                                ]}
                                numberOfLines={2}
                            >
                                {titleCtx.title}
                            </Text>
                        </View>
                    )}

                    {loading ? (
                        <View style={styles.statusBlock}>
                            <ActivityIndicator color={palette.accent} />
                        </View>
                    ) : error ? (
                        <View style={styles.statusBlock}>
                            <Text style={[typography.body, { color: palette.error }]}>
                                {error}
                            </Text>
                        </View>
                    ) : friends.length === 0 ? (
                        <View style={styles.statusBlock}>
                            <Text
                                style={[typography.body, { color: palette.textMuted }]}
                                numberOfLines={3}
                            >
                                You don&apos;t have any friends yet. Add one before sending
                                recs.
                            </Text>
                        </View>
                    ) : (
                        <>
                            {/* Local recipient filter. Mirrors the Friends
                                tab local search: borderless surface pill,
                                inline clear-X (clear-but-stay), Cancel
                                sibling on focus (blur + clear). Selection
                                lives in selectedFriendIds, not the rendered
                                list, so filtering never drops a pick. */}
                            <View style={styles.searchRow}>
                                <View
                                    style={[
                                        styles.searchBar,
                                        { backgroundColor: palette.surface },
                                    ]}
                                >
                                    <SearchIcon
                                        color={palette.textMuted}
                                        size={20}
                                        strokeWidth={ICON_STROKE_WIDTH}
                                    />
                                    <TextInput
                                        ref={localSearchInputRef}
                                        value={localQuery}
                                        onChangeText={setLocalQuery}
                                        placeholder="Search friends"
                                        placeholderTextColor={palette.textMuted}
                                        autoCapitalize="none"
                                        autoCorrect={false}
                                        returnKeyType="search"
                                        onFocus={() => setLocalFocused(true)}
                                        onBlur={() => setLocalFocused(false)}
                                        style={[
                                            styles.searchInput,
                                            typography.body,
                                            { color: palette.text },
                                        ]}
                                    />
                                    {localQuery.length > 0 ? (
                                        <Pressable
                                            onPress={() => setLocalQuery('')}
                                            hitSlop={spacing.sm}
                                            accessibilityRole="button"
                                            accessibilityLabel="Clear search"
                                            style={({ pressed }) => [
                                                pressed && { opacity: 0.6 },
                                            ]}
                                        >
                                            <X
                                                color={palette.textMuted}
                                                size={18}
                                                strokeWidth={ICON_STROKE_WIDTH}
                                            />
                                        </Pressable>
                                    ) : null}
                                </View>
                                {localFocused ? (
                                    <Pressable
                                        onPress={() => {
                                            setLocalQuery('');
                                            localSearchInputRef.current?.blur();
                                        }}
                                        hitSlop={spacing.sm}
                                        accessibilityRole="button"
                                        accessibilityLabel="Cancel search"
                                        style={({ pressed }) => [
                                            styles.cancelButton,
                                            pressed && { opacity: 0.6 },
                                        ]}
                                    >
                                        <Text
                                            style={[
                                                typography.body,
                                                { color: palette.accent },
                                            ]}
                                        >
                                            Cancel
                                        </Text>
                                    </Pressable>
                                ) : null}
                            </View>

                            <Text
                                style={[
                                    typography.micro,
                                    styles.sectionLabel,
                                    { color: palette.textMuted },
                                ]}
                            >
                                SEND TO
                            </Text>
                            {filteredFriends.length > 0 ? (
                                <View style={styles.friendList}>
                                    {filteredFriends.map(renderFriendRow)}
                                </View>
                            ) : (
                                <Text
                                    style={[
                                        typography.body,
                                        styles.noMatch,
                                        { color: palette.textMuted },
                                    ]}
                                >
                                    No friends match “{localQuery.trim()}”.
                                </Text>
                            )}
                        </>
                    )}
                    </Pressable>
                </ScrollView>

                {/* Pinned bottom bar: note input + char count. Send
                    moved to the header so it stays reachable above the
                    keyboard. The bar still pins to the bottom (visible
                    regardless of friend-list scroll position so the
                    note is never below the fold) and its paddingBottom
                    drops the home-indicator inset when the keyboard
                    rises so the bar sits flush against the keyboard. */}
                {!loading && !error && friends.length > 0 ? (
                    <View
                        style={[
                            styles.bottomBar,
                            {
                                backgroundColor: palette.bg,
                                borderTopColor: palette.border,
                                paddingBottom: keyboard.open
                                    ? spacing.sm
                                    : insets.bottom + spacing.sm,
                                // iOS-only direct lift via useKeyboard.
                                // Android relies on adjustResize from the
                                // manifest; double-lifting would push the
                                // bar above the now-shorter window.
                                marginBottom:
                                    Platform.OS === 'ios' && keyboard.open
                                        ? keyboard.height
                                        : 0,
                            },
                        ]}
                    >
                        <Text
                            style={[
                                typography.micro,
                                styles.bottomBarLabel,
                                { color: palette.textMuted },
                            ]}
                        >
                            ADD A NOTE (OPTIONAL)
                        </Text>
                        <View
                            style={[
                                styles.noteBox,
                                {
                                    backgroundColor: palette.surface,
                                    borderColor: palette.border,
                                },
                            ]}
                        >
                            <TextInput
                                value={note}
                                onChangeText={(v) =>
                                    setNote(v.slice(0, NOTE_MAX_LENGTH))
                                }
                                placeholder="Why are you recommending this?"
                                placeholderTextColor={palette.textMuted}
                                multiline
                                maxLength={NOTE_MAX_LENGTH}
                                editable={!sending}
                                style={[
                                    styles.noteInput,
                                    typography.body,
                                    { color: palette.text },
                                ]}
                            />
                        </View>
                        <Text
                            style={[
                                typography.caption,
                                styles.charCount,
                                { color: palette.textMuted },
                            ]}
                        >
                            {note.length}/{NOTE_MAX_LENGTH}
                        </Text>
                    </View>
                ) : null}
            </View>
        </SafeAreaView>
    );
}

function surfaceError(err: unknown, title: string) {
    if (err && typeof err === 'object' && 'message' in err) {
        const supaErr = err as {
            message: string;
            details?: string;
            hint?: string;
            code?: string;
        };
        Alert.alert(
            title,
            `${supaErr.message}${supaErr.hint ? '\n\n' + supaErr.hint : ''}`,
        );
    } else {
        Alert.alert(title, String(err));
    }
}

const styles = StyleSheet.create({
    root: { flex: 1 },
    flex: { flex: 1 },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        // Horizontal inset matches every body element in the modal so
        // the Cancel / Send row edge-aligns with the title context,
        // section labels, friend list, and note box below.
        paddingHorizontal: spacing.lg,
        // Asymmetric vertical padding: a deeper top pushes the
        // Cancel / Recommend / Send row off the modal's top edge
        // (iOS modal presentations don't supply a usable top safe-area
        // inset since the modal sits below the system chrome). Bottom
        // stays tight so the title row that follows isn't oversized.
        paddingTop: spacing.base,
        paddingBottom: spacing.sm,
    },
    scrollContent: {
        paddingBottom: spacing.xl,
    },
    titleContext: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingHorizontal: spacing.lg,
        paddingTop: spacing.md,
        paddingBottom: spacing.lg,
    },
    contextPoster: {
        width: POSTER_W,
        height: POSTER_H,
        borderRadius: radius.sm,
    },
    contextTitle: {
        flex: 1,
    },
    statusBlock: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: spacing.xxl,
        paddingHorizontal: spacing.xl,
    },
    sectionLabel: {
        paddingHorizontal: spacing.lg,
        marginTop: spacing.lg,
        marginBottom: spacing.sm,
        letterSpacing: 0.5,
    },
    searchRow: {
        // Hosts the search pill + conditional Cancel sibling. Horizontal
        // inset matches sectionLabel / friendList so it edge-aligns.
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        paddingHorizontal: spacing.lg,
        marginTop: spacing.md,
        marginBottom: spacing.sm,
    },
    searchBar: {
        // Borderless surface pill (surface-vs-bg is the separation), flex
        // so it shrinks when Cancel appears. Mirrors Friends/library search.
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        paddingHorizontal: spacing.md,
        borderRadius: radius.full,
        height: 44,
    },
    cancelButton: {
        paddingHorizontal: spacing.xs,
    },
    searchInput: {
        flex: 1,
        // Parent's fixed height owns vertical sizing.
        paddingVertical: 0,
    },
    noMatch: {
        paddingHorizontal: spacing.lg,
        paddingTop: spacing.md,
    },
    friendList: {
        paddingHorizontal: spacing.lg,
    },
    friendRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.sm,
        paddingVertical: spacing.md,
        borderRadius: radius.sm,
        gap: spacing.md,
    },
    avatar: {
        width: FRIEND_AVATAR_SIZE,
        height: FRIEND_AVATAR_SIZE,
        borderRadius: FRIEND_AVATAR_SIZE / 2,
    },
    avatarFallback: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    friendText: {
        flex: 1,
        gap: spacing.xs,
    },
    checkCircle: {
        width: 24,
        height: 24,
        borderRadius: 12,
        borderWidth: 1.5,
        alignItems: 'center',
        justifyContent: 'center',
    },
    noteBox: {
        borderRadius: radius.sm,
        borderWidth: 1,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        minHeight: 80,
    },
    noteInput: {
        minHeight: 60,
        // Cap so the bar's height is bounded as the user types — the
        // multiline TextInput scrolls internally for content beyond
        // this height. Without a cap, the bar could grow tall enough
        // to push its bottom edge below the keyboard top.
        maxHeight: 120,
        textAlignVertical: 'top',
    },
    charCount: {
        textAlign: 'right',
        marginTop: spacing.xs,
    },
    // Pinned-bottom container. Top border separates it from the
    // scrolling friend list above. Horizontal padding matches the
    // modal's lg inset so the note box and send button edge-align with
    // the friend list above.
    bottomBar: {
        paddingHorizontal: spacing.lg,
        paddingTop: spacing.md,
        borderTopWidth: StyleSheet.hairlineWidth,
    },
    bottomBarLabel: {
        marginBottom: spacing.sm,
        letterSpacing: 0.5,
    },
});
