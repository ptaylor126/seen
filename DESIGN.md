# Seen — Design System

The visual language of Seen. The source of truth for tokens is `src/theme/theme.ts`. This document explains the why.

## Direction

System-matched appearance. Image-forward. Warm and playful.

The product is built around poster art and personal recommendations. The chrome should be quiet and warm — never compete with imagery, never feel corporate or clinical. Where the product expresses personality, it does so through one warm accent color and considered motion, not visual noise.

## Color

Warm neutrals with a coral accent. The 5% red/yellow shift in the neutrals is deliberate — it makes the app feel inviting rather than sterile.

- **Light mode** background is warm off-white (`#FAF7F2`), not pure white. Pure white competes with poster art.
- **Dark mode** background is deep warm charcoal (`#15110F`), not pure black. Pure black is too aggressive against vibrant poster reds and oranges.
- **Accent** is warm coral (`#E5654A` light / `#F07A5F` dark). Used for primary actions, brand moments, and active states. Used sparingly — coral against neutral is more powerful when it's rare.

Never hardcode hex values in components. Always reference `theme.ts`.

## Typography

**DM Sans**, loaded via `@expo-google-fonts/dm-sans`. Chosen for its slight warmth — softer than Inter, more modern than Open Sans.

Five sizes. Resist the urge to invent new ones; the scale is intentionally constrained.

- `display` (32) — screen titles only
- `heading` (22) — section headers, card titles
- `body` (16) — default text
- `caption` (14) — timestamps, metadata, helper text
- `micro` (12) — labels, badges, tab labels

## Spacing

4-pixel base unit. Almost everything uses `md` (12), `base` (16), or `lg` (24). Tight things (icon-text gaps) use `sm` (8). Screen-level padding uses `xl` (32).

If a spacing value falls between scale values, pick the closer one rather than inventing a new value.

## Radius

Generous, matching the image-forward direction. Poster thumbnails use `lg` (16). Large feature cards use `xl` (24). Buttons and inputs use `sm` (8). Avatars and pill labels are `full`.

## Motion principles

Animations should be quick, purposeful, and calm.

- **Confirmations of user actions** (add to library, send rec, mark watched) deserve a small celebratory moment — scale, color shift, or haptic. These are the dopamine beats of the app.
- **State transitions** (theme change, screen navigation, modal in/out) should fade or slide. Never snap.
- **Errors and loading states** should be quiet — no attention-seeking motion. Calmness reads as competence.
- **Default durations**: 150ms for taps, 250ms for transitions, 400ms for sheet-style modals.
- **Never use bouncy/spring physics for chrome.** Reserve spring for content moments — new rec arrives, friend joins, watched-streak milestone.
- **Always test on a real device.** Simulator motion perception is different.

Specific animation patterns will be documented here as they emerge during the build, not predicted in advance.

## Elevation

Minimal. Two levels.

- `sm` — poster cards floating on background
- `md` — modal sheets only

Image-forward apps don't need heavy shadows. The imagery provides depth.

## What not to do

- No gradients on UI chrome. Gradients are for poster overlays and hero images only.
- No emoji as iconography. Use real icons (SF Symbols on iOS, Material Icons on Android).
- No more than one accent color. Coral is the only brand color.
- No custom fonts beyond DM Sans without team discussion.
- No drop shadows on dark mode surfaces unless absolutely necessary — they read as smudges.
- No animation longer than 400ms in chrome. Long animations are content-only.

## Adding to the theme

If you need a value that isn't in `theme.ts`, the order of operations is:

1. Can you achieve the goal with an existing token? Use that.
2. Does this need exist in more than one place? If yes, add a new token to `theme.ts`.
3. Single-use only? It's probably premature to add a token. Use inline.

Tokens proliferate when this discipline lapses.