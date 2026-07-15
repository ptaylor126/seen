/**
 * Display helpers that append a SCOPE coordinate to a title name — the
 * "{Title} · Season N" and "{Title} · S2 E5" suffixes. Pure formatting, no I/O.
 *
 * Shared so the suffix reads identically everywhere a scoped rec or chat is
 * listed: the inbox (received rec rows, sent rec rows, and chat rows) and the
 * home "Recommended for you" section. Previously both lived locally in
 * inbox.tsx; the home surface needed withSeasonSuffix too, so rather than a
 * third inlined copy of the "· Season N" string, they moved here.
 */

// Season-scoped rec title suffix — the whole-show equivalent of
// withEpisodeSuffix (chat rows), so a season rec reads "{Title} · Season N"
// consistently with how episode chats read "{Title} · S2 E5". null season
// (whole show) leaves the title untouched; season 0 = Specials.
export function withSeasonSuffix(
    name: string | null,
    season: number | null,
): string | null {
    if (!name || season === null) return name;
    return `${name} · ${season === 0 ? 'Specials' : `Season ${season}`}`;
}

// Appends the episode coordinate to a chat's title so an episode chat reads
// "{title} · S2 E5" and is distinguishable from a whole-show chat about the
// same title. Whole-show chats (season/episode null) are returned unchanged.
export function withEpisodeSuffix(
    name: string | null,
    scope: { season: number | null; episode: number | null } | undefined,
): string | null {
    if (!name || !scope || scope.season === null || scope.episode === null) {
        return name;
    }
    return `${name} · S${scope.season} E${scope.episode}`;
}
