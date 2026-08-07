// Build-time feature flags — plain constants, flipped by OTA.
//
// The pattern: a native capability ships DORMANT in a binary (the
// dependency compiled in, no visible UI), then the feature that uses it
// lands later as pure JS behind the flag and the flag flips in the same
// OTA. Keeps binary cuts and feature launches decoupled.

// Library import (IMDb ratings.csv / Letterboxd / TV Time GDPR export).
// expo-document-picker ships in the iOS 1.0.6 / Android vc6 binaries for
// this; the parsers, preview UI, and import screens are stage 2, by OTA.
// Flip to true when stage 2 lands.
export const LIBRARY_IMPORT_ENABLED = true;
