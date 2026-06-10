/**
 * ISO 639-1 code → English language name. Covers the long tail of
 * TMDB's `original_language` values across world cinema — Asian, South
 * Asian, Middle Eastern, European, Latin American.
 *
 * Why a static map instead of `Intl.DisplayNames`: Hermes (the JS
 * engine bundled with Expo SDK 54 / RN 0.81) does not reliably expose
 * `Intl.DisplayNames` for `type: 'language'`. On platforms where the
 * constructor exists, `.of('ja')` can still return `undefined` for
 * codes the embedded ICU doesn't carry — both failure modes silently
 * resolve to an empty string (with `?? ''`), so a runtime-conditional
 * Intl path is exactly the kind of "looks fine in dev, ships nothing
 * in prod" bug we want to avoid. A 50-entry static map is small,
 * deterministic, and matches the pattern used for TMDB_GENRE_NAMES.
 *
 * Sourced 2026-06-09 from ISO 639-1 with TMDB-flavoured choices:
 *   - 'cn' is a TMDB extension (not standard ISO 639-1) used for
 *     Cantonese / "Chinese" — included so Hong Kong cinema renders.
 *   - 'xx' is TMDB's "no spoken language" sentinel — included so
 *     silent films and music-only titles map deliberately rather
 *     than landing in the omit-on-unmapped fallback.
 *
 * Behaviour at the call site: codes NOT in this map are omitted from
 * the meta line silently. With ~50 entries covering the practical
 * universe of TMDB original_language values, omission should be rare.
 * If a real title comes through with a code not on this list, add it
 * here — that's a one-line maintenance task, not a runtime bug.
 */
export const LANGUAGE_NAMES: ReadonlyMap<string, string> = new Map([
    // East Asian
    ['ja', 'Japanese'],
    ['ko', 'Korean'],
    ['zh', 'Chinese'],
    ['cn', 'Chinese'],       // TMDB extension; Cantonese / Hong Kong cinema
    ['mn', 'Mongolian'],
    // South & Southeast Asian
    ['hi', 'Hindi'],
    ['ta', 'Tamil'],
    ['te', 'Telugu'],
    ['ml', 'Malayalam'],
    ['kn', 'Kannada'],
    ['bn', 'Bengali'],
    ['mr', 'Marathi'],
    ['pa', 'Punjabi'],
    ['ur', 'Urdu'],
    ['ne', 'Nepali'],
    ['si', 'Sinhala'],
    ['th', 'Thai'],
    ['vi', 'Vietnamese'],
    ['id', 'Indonesian'],
    ['ms', 'Malay'],
    ['tl', 'Tagalog'],
    ['km', 'Khmer'],
    // Middle Eastern
    ['ar', 'Arabic'],
    ['fa', 'Persian'],
    ['he', 'Hebrew'],
    ['tr', 'Turkish'],
    ['ku', 'Kurdish'],
    // Romance
    ['fr', 'French'],
    ['es', 'Spanish'],
    ['it', 'Italian'],
    ['pt', 'Portuguese'],
    ['ro', 'Romanian'],
    ['ca', 'Catalan'],
    ['la', 'Latin'],
    // Germanic
    ['de', 'German'],
    ['nl', 'Dutch'],
    ['sv', 'Swedish'],
    ['da', 'Danish'],
    ['no', 'Norwegian'],
    ['nb', 'Norwegian'],     // Bokmål — TMDB sometimes uses this
    ['is', 'Icelandic'],
    ['fi', 'Finnish'],       // (Uralic, but slots with the Nordic films)
    // Slavic
    ['ru', 'Russian'],
    ['uk', 'Ukrainian'],
    ['pl', 'Polish'],
    ['cs', 'Czech'],
    ['sk', 'Slovak'],
    ['hr', 'Croatian'],
    ['sr', 'Serbian'],
    ['bs', 'Bosnian'],
    ['sl', 'Slovenian'],
    ['mk', 'Macedonian'],
    ['bg', 'Bulgarian'],
    // Hellenic, Celtic, other European
    ['el', 'Greek'],
    ['ga', 'Irish'],
    ['cy', 'Welsh'],
    ['sq', 'Albanian'],
    ['hu', 'Hungarian'],
    ['et', 'Estonian'],
    ['lv', 'Latvian'],
    ['lt', 'Lithuanian'],
    ['eu', 'Basque'],
    // African
    ['sw', 'Swahili'],
    ['am', 'Amharic'],
    ['yo', 'Yoruba'],
    ['zu', 'Zulu'],
    ['af', 'Afrikaans'],
    // TMDB sentinel — silent films, music videos, etc.
    ['xx', 'No spoken language'],
]);
