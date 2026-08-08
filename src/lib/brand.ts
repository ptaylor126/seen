/**
 * Brand bitmap assets — split from the native splash.
 *
 * assets/logo.png is DUAL-MASTERED: it is the native splash image
 * (app.json expo-splash-screen → baked into the binary at prebuild, so
 * its bytes are fingerprint-relevant) AND the wordmark three screens
 * require() from JS (home header, onboarding welcome, sign-in). The V2
 * train shipped a navy logo.png, which moved both fingerprints and was
 * reverted (08476cd) to hold the OTA — silently reverting the JS
 * wordmark to plum as well: the "navy app, plum wordmark" bug.
 *
 * logo-v2.png carries the navy-era wordmark for the JS sites ONLY.
 * app.json still references logo.png, so this file rides the OTA
 * bundle without touching the fingerprint. The native splash itself
 * goes navy with the 1.0.7/vc7 binary, at which point logo.png can be
 * re-unified and this split retired.
 */
import { THEME_V2_ENABLED } from '@/theme/theme';

export const WORDMARK = THEME_V2_ENABLED
    ? require('../../assets/logo-v2.png')
    : require('../../assets/logo.png');
