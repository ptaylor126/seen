import * as Localization from 'expo-localization';

// Device's ISO 3166-1 alpha-2 region code (e.g. 'US', 'GB', 'DE').
// Falls back to 'US' when the OS reports no region — happens with some
// synthetic locales and on rare developer-mode configurations.
//
// Memoised at module load: the device region doesn't change while the app
// is running (changing locale on iOS / Android relaunches the app), so
// reading it once is sufficient and avoids the native bridge cost on every
// call site.
const DEFAULT_REGION = 'US';

const REGION = (() => {
    const locale = Localization.getLocales()[0];
    const code = locale?.regionCode;
    return code && code.length > 0 ? code.toUpperCase() : DEFAULT_REGION;
})();

export function getRegion(): string {
    return REGION;
}
