import { Dimensions } from 'react-native';

import { spacing } from '@/theme/theme';

// 2:3 poster aspect (height = width × 1.5). Shared so poster surfaces can't
// drift on the ratio.
export const POSTER_ASPECT = 1.5;

// The full-bleed horizontal "poster strip" — the friend profile's "Recs
// between you" and "Chats between you" rows. Poster width is derived from the
// screen so ~3.5 posters show with the next HALF-CUT at the right edge, a clear
// "scrolls horizontally" cue on any device. INSET/GAP must line up with the
// scroll container's leading inset + inter-card gap for the peek math to hold.
// ONE definition, imported by every strip, so they can never drift out of sync
// (a comment promising to keep two copies aligned is not a mechanism).
export const POSTER_STRIP_INSET = spacing.base;
export const POSTER_STRIP_GAP = spacing.md;
export const POSTER_STRIP_W = Math.floor(
    (Dimensions.get('window').width - POSTER_STRIP_INSET - 3 * POSTER_STRIP_GAP) /
        3.5,
);
export const POSTER_STRIP_H = Math.round(POSTER_STRIP_W * POSTER_ASPECT);
