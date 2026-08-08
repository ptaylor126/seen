import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Check, Search as SearchIcon, X } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Keyboard,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    useColorScheme,
    View,
} from 'react-native';
import {
    KeyboardStickyView,
    useKeyboardState,
    useReanimatedKeyboardAnimation,
} from 'react-native-keyboard-controller';
import Animated, {
    interpolate,
    useAnimatedStyle,
} from 'react-native-reanimated';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { FullScreenLoader, useDeferredLoading } from '@/components/full-screen-loader';
import { COMMENT_MAX_CHARS } from '@/components/thread/shared';
import { createTitleChat } from '@/lib/chats';
import supabase from '@/lib/supabase';
import { ensureTitle, type EnsureTitleArgs } from '@/lib/titles';
import { getMovie, getTV, imageUrl, type TMDBMovie, type TMDBTV } from '@/lib/tmdb';
import {
    button,
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

const FRIEND_AVATAR_SIZE = 44;
// The selected-friend chip in the message bar is deliberately smaller/quieter
// than the friend-list rows above.
const RECIPIENT_AVATAR_SIZE = 24;
const POSTER_W = 40;
const POSTER_H = 60;

// "Chat about it" compose flow: pick ONE friend, write a first message
// (required), send → createTitleChat → dismiss this modal + push the chat
// thread (see handleSend for why not replace).
// Structural clone of the recommend picker (same scaffold: header actions,
// local search, recency-ordered friend list, KeyboardStickyView message bar)
// with the rec-only pieces removed: single-select instead of a recipient
// set, message required instead of an optional note, no already-has heads-up
// (chatting about something they've seen is the point), and no send fan-out —
// one friend, one chat.
export default function TitleChatComposeScreen() {
    const params = useLocalSearchParams<{
        mediaType: string;
        tmdbId: string;
        // Pre-selected friend id, forwarded by the overlap flows (banner /
        // inbox row → watcher pick) when no chat exists yet — the user
        // lands here with the friend checked and just writes the opener.
        preselect?: string;
        // 'overlap' when arriving via goToChatAboutTitle (the friend has
        // SEEN the title) — flips the message placeholder to "Worth
        // watching?". Absent on the title page's direct "Chat about it"
        // door, which keeps the generic placeholder.
        intent?: string;
        // Episode scope, forwarded by the episode-list door. Both present →
        // an episode chat; absent → a whole-show chat. Passed straight to
        // createTitleChat, which enforces both-or-neither.
        season?: string;
        episode?: string;
    }>();
    const router = useRouter();
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const insets = useSafeAreaInsets();
    // Keyboard plumbing — same as the recommend picker: keyboardState pads
    // the list while searching; the message bar rides its own
    // KeyboardStickyView, with the closed-state home-indicator clearance
    // animated on the same keyboard progress.
    const keyboardState = useKeyboardState();
    const keyboardProgress = useReanimatedKeyboardAnimation().progress;
    const barClearanceStyle = useAnimatedStyle(() => ({
        transform: [
            {
                translateY: interpolate(
                    keyboardProgress.value,
                    [0, 1],
                    [-insets.bottom, 0],
                ),
            },
        ],
    }));

    const mediaType: MediaType | null =
        params.mediaType === 'movie' || params.mediaType === 'tv'
            ? (params.mediaType as MediaType)
            : null;
    const tmdbIdRaw = typeof params.tmdbId === 'string' ? params.tmdbId : '';
    const tmdbId = Number.parseInt(tmdbIdRaw, 10);

    // Episode scope (both-or-neither). Only honoured for TV; a malformed or
    // half-present pair collapses to a whole-show chat.
    const seasonParam =
        typeof params.season === 'string'
            ? Number.parseInt(params.season, 10)
            : NaN;
    const episodeParam =
        typeof params.episode === 'string'
            ? Number.parseInt(params.episode, 10)
            : NaN;
    const episodeScope =
        mediaType === 'tv' &&
        Number.isFinite(seasonParam) &&
        Number.isFinite(episodeParam)
            ? { season: seasonParam, episode: episodeParam }
            : null;

    const [titleCtx, setTitleCtx] = useState<TitleContext | null>(null);
    // Full catalogue metadata, captured at load so the send can stamp
    // public.titles via ensureTitle — step 4's inbox rows for the chat kinds
    // resolve titles the same way rec rows do, so stamp up front.
    const [titleStamp, setTitleStamp] = useState<EnsureTitleArgs | null>(null);
    const [friends, setFriends] = useState<FriendRow[]>([]);
    // SINGLE-select: a chat is two-party (schema-enforced), so picking a
    // friend replaces any prior pick; tapping the selected row deselects.
    // Seeds from the preselect param (never re-applied after mount — once
    // the user picks, they own the selection; mirrors the recommend picker).
    const [selectedFriendId, setSelectedFriendId] = useState<string | null>(
        () =>
            typeof params.preselect === 'string' && params.preselect.length > 0
                ? params.preselect
                : null,
    );
    const [message, setMessage] = useState('');
    const [loading, setLoading] = useState(true);
    const showLoader = useDeferredLoading(loading);
    const [error, setError] = useState<string | null>(null);
    const [sending, setSending] = useState(false);
    // Local friend filter — same borderless pill + Done pattern as the
    // recommend picker / Friends tab.
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
                    // Same recency ranking as the recommend picker — friends
                    // you've interacted with most recently rise to the top.
                    supabase
                        .from('recommendations')
                        .select('to_user_id, sent_at')
                        .eq('from_user_id', userId)
                        .order('sent_at', { ascending: false }),
                ]);
                if (profilesError) throw profilesError;
                if (sentRecsError) throw sentRecsError;
                if (!active) return;

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
                console.error('chat compose init failed:', err);
                setError(err instanceof Error ? err.message : 'Failed to load');
            } finally {
                if (active) setLoading(false);
            }
        })();

        return () => {
            active = false;
        };
    }, [mediaType, tmdbId]);

    const trimmedMessage = message.trim();
    // Message is REQUIRED (unlike the rec note): a chat with no opener is an
    // empty thread the other party can't make sense of.
    const canSend =
        !sending &&
        selectedFriendId !== null &&
        trimmedMessage.length > 0 &&
        mediaType !== null &&
        !loading;

    const selectedFriend =
        friends.find((f) => f.userId === selectedFriendId) ?? null;

    const normalizedQuery = localQuery.trim().toLowerCase();
    const filteredFriends =
        normalizedQuery.length === 0
            ? friends
            : friends.filter((f) =>
                  `${f.displayName} @${f.handle}`
                      .toLowerCase()
                      .includes(normalizedQuery),
              );

    function pickFriend(userId: string) {
        const isAdding = selectedFriendId !== userId;
        // Single-select: tap replaces the pick; tapping the current pick
        // deselects it.
        setSelectedFriendId((prev) => (prev === userId ? null : userId));
        // On ADD only: dismiss the keyboard so the search blurs and the
        // message bar expands into view — same reveal logic as the
        // recommend picker.
        if (isAdding) Keyboard.dismiss();
    }

    async function handleSend() {
        if (!canSend || !mediaType || !selectedFriendId) return;
        setSending(true);
        try {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            const userId = session?.user.id;
            if (!userId) throw new Error('Not authenticated');

            // Stamp the title into public.titles (fire-and-forget) so
            // step 4's inbox rows can resolve it, mirroring the rec send.
            if (titleStamp) void ensureTitle(titleStamp);

            // createTitleChat handles the direction-agnostic 23505: if a
            // chat with this friend about this title already exists (either
            // direction), the message posts into it and we land there — the
            // user never sees the difference.
            const chatId = await createTitleChat({
                userId,
                otherUserId: selectedFriendId,
                tmdbId,
                mediaType,
                firstMessage: trimmedMessage,
                // Whole-show chat when null; an episode chat when the door
                // forwarded a season + episode.
                season: episodeScope?.season ?? null,
                episode: episodeScope?.episode ?? null,
            });

            // Dismiss this modal, then push the chat — the app's modal
            // vocabulary (recommend exits with back(); screens are entered
            // with push()). Resulting stack: title → chat, so back from the
            // chat lands on the title page, not this spent compose screen.
            //
            // NOTE the chat route MUST be presented as fullScreenModal (see
            // _layout.tsx): the title page underneath is itself a presented
            // fullScreenModal, and a 'card' pushed over it attaches BEHIND
            // the modal — the original "chat never appears" bug was that
            // presentation topology, not navigation timing.
            router.back();
            router.push(`/chat/${chatId}`);
        } catch (err) {
            console.error('start chat failed:', err);
            surfaceError(err, "Couldn't start the chat");
            setSending(false);
        }
    }

    function renderFriendRow(row: FriendRow) {
        const isSelected = selectedFriendId === row.userId;
        return (
            <Pressable
                key={row.userId}
                onPress={() => pickFriend(row.userId)}
                accessibilityRole="button"
                accessibilityState={{ selected: isSelected }}
                style={({ pressed }) => [
                    styles.friendRow,
                    isSelected && { backgroundColor: palette.accentSubtle },
                    pressed && { opacity: 0.6 },
                ]}
            >
                {/* Shared color-by-id Avatar (NOT the recommend screen's
                    bespoke accent-fill renderAvatar — that's flagged tech
                    debt; new surfaces use the shared component). */}
                <Avatar
                    avatarUrl={row.avatarUrl}
                    displayName={row.displayName}
                    seedId={row.userId}
                    size={FRIEND_AVATAR_SIZE}
                />
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
                    Chat about it
                </Text>
                {/* Send in the header (opposite Cancel) so it never moves
                    with the keyboard — same reachability rationale as the
                    recommend picker. FILLED primary (vs Cancel's text-link):
                    plum + white when actionable (kept plum while the send is
                    in flight — spinner on the fill), muted surfaceAlt +
                    textMuted when Send isn't available so it clearly reads
                    non-tappable rather than a bright button that does
                    nothing. */}
                <Pressable
                    onPress={handleSend}
                    disabled={!canSend}
                    hitSlop={spacing.sm}
                    accessibilityRole="button"
                    accessibilityLabel="Send"
                    accessibilityState={{ disabled: !canSend }}
                    style={({ pressed }) => [
                        styles.sendButton,
                        {
                            backgroundColor:
                                canSend || sending
                                    ? palette.accent
                                    : palette.surfaceAlt,
                            opacity: pressed && canSend ? 0.8 : 1,
                        },
                    ]}
                >
                    {sending ? (
                        <ActivityIndicator color={palette.textInverse} />
                    ) : (
                        <Text
                            style={[
                                typography.bodyEmphasis,
                                {
                                    color: canSend
                                        ? palette.textInverse
                                        : palette.textMuted,
                                },
                            ]}
                        >
                            Send
                        </Text>
                    )}
                </Pressable>
            </View>

            <View style={styles.flex}>
                <ScrollView
                    style={styles.flex}
                    keyboardShouldPersistTaps="handled"
                    keyboardDismissMode="on-drag"
                    contentContainerStyle={[
                        styles.scrollContent,
                        keyboardState.height > 0
                            ? { paddingBottom: keyboardState.height + spacing.sm }
                            : null,
                    ]}
                >
                    <Pressable
                        onPress={() => Keyboard.dismiss()}
                        accessibilityElementsHidden
                        importantForAccessibility="no-hide-descendants"
                    >
                    {/* Title context — collapsed while the friend search is
                        focused, same as the recommend picker. */}
                    {titleCtx && !localFocused && (
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

                    {showLoader ? (
                        <FullScreenLoader />
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
                                You don&apos;t have any friends yet. Add one before
                                starting a chat.
                            </Text>
                        </View>
                    ) : (
                        <>
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
                                        accessibilityLabel="Done searching"
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
                                            Done
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
                                CHAT WITH
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

                {/* Pinned message bar — same KeyboardStickyView + clearance
                    mechanics as the recommend picker's note bar, but the
                    message is REQUIRED (no "(OPTIONAL)"). */}
                {!loading && !error && friends.length > 0 && !localFocused ? (
                    <KeyboardStickyView>
                    <Animated.View
                        style={[
                            styles.bottomBar,
                            barClearanceStyle,
                            {
                                backgroundColor: palette.bg,
                                borderTopColor: palette.border,
                                paddingBottom: spacing.sm,
                            },
                        ]}
                    >
                        {selectedFriend ? (
                            <View style={styles.recipientChip}>
                                <Avatar
                                    avatarUrl={selectedFriend.avatarUrl}
                                    displayName={selectedFriend.displayName}
                                    seedId={selectedFriend.userId}
                                    size={RECIPIENT_AVATAR_SIZE}
                                />
                                <Text
                                    style={[
                                        typography.caption,
                                        styles.recipientName,
                                        { color: palette.textMuted },
                                    ]}
                                    numberOfLines={1}
                                >
                                    {selectedFriend.displayName}
                                </Text>
                            </View>
                        ) : null}
                        <Text
                            style={[
                                typography.micro,
                                styles.bottomBarLabel,
                                { color: palette.textMuted },
                            ]}
                        >
                            MESSAGE
                        </Text>
                        <View
                            style={[
                                styles.messageBox,
                                { backgroundColor: palette.surface },
                            ]}
                        >
                            <TextInput
                                value={message}
                                onChangeText={(v) =>
                                    setMessage(v.slice(0, COMMENT_MAX_CHARS))
                                }
                                placeholder={
                                    params.intent === 'overlap'
                                        ? 'Worth watching?'
                                        : 'Have you seen this?'
                                }
                                placeholderTextColor={palette.textMuted}
                                multiline
                                maxLength={COMMENT_MAX_CHARS}
                                editable={!sending}
                                style={[
                                    styles.messageInput,
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
                            {message.length}/{COMMENT_MAX_CHARS}
                        </Text>
                    </Animated.View>
                    </KeyboardStickyView>
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
        paddingHorizontal: spacing.lg,
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
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        paddingHorizontal: spacing.lg,
        marginTop: spacing.md,
        marginBottom: spacing.sm,
    },
    searchBar: {
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
    sendButton: {
        // Compact filled header button — the app's button radius (the
        // shared geometry token) at header scale; fill/label colors resolve
        // per state inline (plum/white actionable, surfaceAlt/muted
        // disabled).
        paddingVertical: spacing.sm,
        paddingHorizontal: spacing.base,
        borderRadius: button.borderRadius,
        alignItems: 'center',
        justifyContent: 'center',
    },
    searchInput: {
        flex: 1,
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
    friendText: {
        flex: 1,
        gap: spacing.xs,
    },
    checkCircle: {
        width: 24,
        height: 24,
        borderRadius: radius.full,
        borderWidth: 1.5,
        alignItems: 'center',
        justifyContent: 'center',
    },
    bottomBar: {
        paddingHorizontal: spacing.lg,
        paddingTop: spacing.md,
        borderTopWidth: StyleSheet.hairlineWidth,
    },
    bottomBarLabel: {
        marginBottom: spacing.sm,
        letterSpacing: 0.5,
    },
    recipientChip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        marginBottom: spacing.sm,
    },
    recipientName: {
        maxWidth: 200,
    },
    messageBox: {
        // Borderless surface fill, matching the "Search friends" field above
        // (surface-vs-bg is the separation) — taller/multi-line stays, only
        // the stroke goes.
        borderRadius: radius.sm,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        minHeight: 80,
    },
    messageInput: {
        minHeight: 60,
        maxHeight: 120,
        textAlignVertical: 'top',
    },
    charCount: {
        textAlign: 'right',
        marginTop: spacing.xs,
    },
});
