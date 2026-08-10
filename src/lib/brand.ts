/**
 * Brand bitmap assets.
 *
 * logo.png is dual-mastered by design: the native splash image (app.json
 * expo-splash-screen) AND the wordmark three screens render (home header,
 * onboarding welcome, sign-in). As of the vc7 branch both masters are the
 * navy-era art, so one file serves both again — the logo-v2.png split that
 * carried the navy wordmark over OTA against the cream-splash binaries is
 * retired. If the splash and wordmark ever need to diverge again, re-split
 * rather than editing this file's export in place (see 6c82305 for the
 * pattern and the fingerprint reasoning).
 */
export const WORDMARK = require('../../assets/logo.png');
