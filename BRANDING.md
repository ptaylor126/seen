# Seen — colour usage rules

**Principle: colour carries meaning, not decoration. The accent guides the eye to what the user can do.**

Hierarchy, structure, and emphasis are carried by **typography** (weight, size) and the **navy surfaces**. Colour is reserved for signalling. If everything is highlighted, nothing is — the accent only works as a guide when it's used sparingly.

---

## Accent — periwinkle `#9D8DF0` — means "act here" or "you are here"

Use it ONLY for:

1. **The primary action on a screen.** One filled accent pill per screen. Secondary actions are outlined/ghost — never a second filled accent competing with the first.
2. **Interactive text.** Tappable links ("Forgot password?", "Continue with email", "Have an invite link?", "Back to sign in"). If it isn't tappable, it isn't accent.
3. **Active / selected / current state.** The selected tab, the active filter, focus rings.

**Never use accent for:** decoration, non-interactive emphasis, drawing attention to something the user can't act on, or icons that aren't buttons.

**The test:** if the user can't tap it, and it doesn't tell them where they are, it is not accent. Use typography and navy surfaces instead.

---

## Navy surfaces carry structure

- `#0B0D26` — **ground.** Base background.
- `#162954` — **surfaceAlt / emphasis.** Raised surfaces, cards, selected states.

Depth, grouping, and separation come from these surfaces and from spacing — not from colour.

---

## Text

- `#E6E6E6` — **primary text.**
- `#847B7B` (textMuted) — **secondary / muted text,** captions, non-interactive labels. De-emphasised text should be muted grey — NOT a dimmed accent. Dimming the accent to de-emphasise is a common mistake; it still reads as "action" at low confidence. Use the muted grey.

---

## Notification colour — light lavender `#CFC9EE` — transient informational feedback

For toasts and momentary status only: "Marked watched", "Seen it", "Copied", "Link sent".

- Background: light lavender `#CFC9EE`.
- Text/icon: **dark** (navy ground `#0B0D26`) — the surface is light, so text must be dark for contrast. A light-on-light or dark-on-dark toast is the bug this rule exists to prevent.
- Full-width (standard horizontal margins), readable height.

**Why it's not the accent:** a toast is informational, not an action — the user doesn't tap it. Using the action accent (`#9D8DF0`) for a non-action steals the "act here" signal and dilutes it. The light lavender is in the same hue family (so it feels like Seen and reads as coherent) but is clearly distinct from the accent (so a toast is never mistaken for a button). It's light, so it stands out from the navy ground — which the navy surfaces cannot do for a notification.

**Notifications are the one non-action use of a bright colour, and only because they are transient and do not persist as competing signals. Persistent UI does not get this licence.**

---

## Quick reference

| Token | Hex | Meaning / use |
|---|---|---|
| ground | `#0B0D26` | base background |
| surfaceAlt | `#162954` | raised / selected surfaces |
| accent | `#9D8DF0` | **actions & wayfinding only** |
| notification | `#CFC9EE` | transient toasts (dark text on it) |
| text | `#E6E6E6` | primary text |
| textMuted | `#847B7B` | secondary / non-interactive text |

---

## Follow-up: accent-usage audit

These rules are new; existing screens predate them. A one-pass audit is worth doing: find every place the accent (`#9D8DF0`) currently appears, classify each as **action / wayfinding / decoration**, and pull the decoration cases back to typography or navy. Reserve the accent so it means something.
