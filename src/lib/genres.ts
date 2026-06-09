/**
 * TMDB genre id → name. Merged from /genre/movie/list and
 * /genre/tv/list.
 *
 * Some ids are shared between movie and TV (and resolve to the same
 * name in both lists — e.g. 18 = Drama, 35 = Comedy, 16 = Animation);
 * some are movie-only (28 = Action, 27 = Horror, 53 = Thriller);
 * some are TV-only (10759 = Action & Adventure, 10765 = Sci-Fi &
 * Fantasy, 10768 = War & Politics).
 *
 * Sourced 2026-06-09 from TMDB v3. The catalogue is stable enough that
 * a hardcoded constant beats a runtime fetch + cache layer; bump this
 * by hand if TMDB ever revises the list. The library reads genre_ids
 * straight from public.titles (denormalised in stage 2) and looks up
 * names via this map at render time.
 */
export const TMDB_GENRE_NAMES: ReadonlyMap<number, string> = new Map([
    // Movie genres (also includes the ids shared with TV)
    [28, 'Action'],
    [12, 'Adventure'],
    [16, 'Animation'],
    [35, 'Comedy'],
    [80, 'Crime'],
    [99, 'Documentary'],
    [18, 'Drama'],
    [10751, 'Family'],
    [14, 'Fantasy'],
    [36, 'History'],
    [27, 'Horror'],
    [10402, 'Music'],
    [9648, 'Mystery'],
    [10749, 'Romance'],
    [878, 'Science Fiction'],
    [10770, 'TV Movie'],
    [53, 'Thriller'],
    [10752, 'War'],
    [37, 'Western'],
    // TV-only additions
    [10759, 'Action & Adventure'],
    [10762, 'Kids'],
    [10763, 'News'],
    [10764, 'Reality'],
    [10765, 'Sci-Fi & Fantasy'],
    [10766, 'Soap'],
    [10767, 'Talk'],
    [10768, 'War & Politics'],
]);
