---
version: alpha
name: Terroir — Nocturne
description: A cellar at night. Cool near-black grounds, bone-white ink, one claret red, one champagne mark. The wine is the only colour in the room; photography carries the warmth so no surface has to. Set in Source Serif 4 over Source Sans 3, sentence case. Brown and cream are banned outright, in every mode.
colors:
  primary: "#96122A"
  primary-hover: "#B01230"
  accent: "#96122A"
  canvas: "#F4F5F6"
  surface: "#FFFFFF"
  surface-raised: "#F1F3F5"
  surface-sunken: "#E8EAEC"
  wash: "#EDEFF1"
  ink: "#0B0D10"
  ink-soft: "#33383D"
  grey: "#626B72"
  ink-disabled: "#8A939B"
  rule: "#DCDFE2"
  rule-strong: "#C6CBD0"
  edge: "#7C8893"
  focus: "#96122A"
  seal-ink: "#F7F8F9"
  ready: "#2C774E"
  ready-wash: "#E4F0EA"
  ready-ink: "#215C3C"
  hold: "#2D6A9F"
  hold-wash: "#E3EEF6"
  hold-ink: "#22506F"
  peak-wash: "#E8EAEC"
  peak-ink: "#0B0D10"
  risk-wash: "#F7E4E8"
  risk-ink: "#96122A"
  glass: "rgba(255, 255, 255, 0.72)"
  glass-edge: "rgba(11, 13, 16, 0.10)"
  shadow-card: "rgba(11, 13, 16, 0.08)"
  dark-primary: "#D01A3C"
  dark-primary-hover: "#E23B58"
  dark-accent: "#EEF1F4"
  dark-champagne: "#E6DCAE"
  dark-canvas: "#07080A"
  dark-surface: "#0E1013"
  dark-surface-raised: "#161A1E"
  dark-surface-sunken: "#030405"
  dark-wash: "#101317"
  dark-ink: "#EEF1F4"
  dark-ink-soft: "#AEB7BF"
  dark-grey: "#79838B"
  dark-ink-disabled: "#5A6169"
  dark-rule: "rgba(238, 241, 244, 0.09)"
  dark-rule-strong: "rgba(238, 241, 244, 0.17)"
  dark-edge: "#757F88"
  dark-focus: "#E6DCAE"
  dark-ready: "#4FB07A"
  dark-ready-wash: "#0F2419"
  dark-ready-ink: "#8FD9AF"
  dark-hold: "#6BA8D6"
  dark-hold-wash: "#0D1D2A"
  dark-hold-ink: "#A9CFEA"
  dark-peak-wash: "#1F242A"
  dark-peak-ink: "#EEF1F4"
  dark-risk-wash: "#2A0A11"
  dark-risk-ink: "#F2879C"
  dark-glass: "rgba(7, 8, 10, 0.68)"
  dark-seal-ink: "#FFFFFF"
  dark-glass-edge: "rgba(238, 241, 244, 0.14)"
typography:
  display-family: "Source Serif 4, Iowan Old Style, Georgia, serif"
  ui-family: "Source Sans 3, ui-sans-serif, system-ui, sans-serif"
  mono-family: "Source Code Pro, ui-monospace, SFMono-Regular, monospace"
  signature-family: "Ephesis, Snell Roundhand, cursive"
  micro: { size: "10px", line: 1.4, tracking: "0.06em", role: "non-essential microcopy only" }
  caption: { size: "11px", line: 1.5, tracking: "0.18em", case: "uppercase", weight: 600 }
  ledger: { size: "12px", line: 1.4, role: "dense metadata, timestamps, secondary figures" }
  body-sm: { size: "13px", line: 1.55 }
  control: { size: "14px", line: 1.45, role: "anything you tap, type into, or read inside a table row" }
  body: { size: "15px", line: 1.6 }
  body-lg: { size: "17px", line: 1.5, role: "wine name in a row or card; mobile primary" }
  subheading: { size: "20px", line: 1.4 }
  heading-sm: { size: "27px", line: 1.22 }
  heading: { size: "42px", line: 1.1, tracking: "-0.01em", case: "sentence" }
  display: { size: "72px", line: 1.04, tracking: "-0.015em", case: "sentence" }
  signature: { size: "44px", line: 1.2, case: "sentence" }
rounded:
  sm: "6px"
  md: "10px"
  lg: "14px"
  card: "16px"
  pill: "999px"
spacing:
  3xs: "4px"
  2xs: "2px"
  xs: "8px"
  sm: "14px"
  md: "18px"
  lg: "24px"
  xl: "36px"
  2xl: "48px"
  3xl: "80px"
density:
  compact: { row: "48px", pad-y: "8px", type: "ledger" }
  standard: { row: "64px", pad-y: "14px", type: "control" }
  relaxed: { row: "84px", pad-y: "18px", type: "body-lg" }
layers:
  base: 0
  sticky: 10
  chrome: 20
  drag: 30
  overlay: 40
  dialog: 50
  toast: 60
motion:
  fast: "120ms"
  normal: "200ms"
  slow: "320ms"
  ease-standard: "cubic-bezier(0.2, 0, 0, 1)"
  ease-exit: "cubic-bezier(0.3, 0, 1, 1)"
chrome:
  header: "54px"
  tabbar: "64px"
  fab: "56px"

# Terroir — Nocturne

Supersedes **Terroir — Cantina** (2026-08-26), archived at
`docs/design/DESIGN-cantina-2026-08-26.md`. Revised 2026-08-29 after a
two-pass system audit; the previous revision is at
`docs/design/DESIGN-nocturne-typography-2026-08-29.md`.

## Overview

Cantina described a cream tasting room by day and a gold-black lacquered
cellar by night. In practice the cream ground, the Didone paragraphs and the
burgundy anchor landed on the single most common machine-generated look there
is. Worse, its method manufactured the one colour this project has banned:
every neutral was tinted warm so the room would feel candlelit, and a warm
neutral at low lightness *is* brown. You cannot ban the output and keep the
process that produces it.

Nocturne inverts the method. **Warmth comes from pictures, never from paint.**
The paint is cold — near-black grounds, bone-white ink, greys that lean blue.
The warmth in the room comes from the photographs: a candlelit plate, a label,
the colour of the wine in a glass. Brown is not discouraged here; it is
structurally unavailable, because nothing in the palette is capable of it.

This revision does not change that thesis. It repairs the parts of the system
that were decorative rather than operational: colours that could not be read,
lines that could not be seen, a type scale the codebase ignored 80% of the
time, and a row system that had been rebuilt by hand six times.

### The two rooms

**Nocturne** is the dark room and the primary one. A sommelier works a floor at
20 lux with a phone at low brightness; the app should not be the brightest
object in the dining room.

**Daylight** is the same system with the grounds inverted — an office, a
purchasing screen, a printed list. It is not a courtesy mode. Every rule below
is stated for both.

## Colours

### Ground and ink

Five grounds: `surface-sunken`, `wash`, `surface-raised`, `canvas`, `surface`
on Daylight; the same five names inverted on Nocturne. Three inks: `ink` for
anything that must be read, `ink-soft` for supporting prose, `grey` for
metadata. Nothing else carries text.

**`surface-raised` means "separated from the ground", not "lighter".** On
Nocturne a hovered row lifts from `#0E1013` to `#161A1E`. On Daylight a card is
already white, so there is nowhere lighter to go and raising it *darkens* it, to
`#F1F3F5`. It was `#FFFFFF` in the first draft of this revision — identical to
`surface`, which made the hover and selected states in the state table below
render as no change at all.

Both greys were repaired in this revision. `dark-grey` was `#757F88`, which
measured **4.29:1** on `dark-surface-raised` — below the 4.5:1 floor, and
`surface-raised` is exactly where a hovered or selected row sits. It is now
`#79838B` (4.52:1 at worst). Daylight `grey` was `#6B747C`, which failed on
three of four grounds (3.94:1 on `surface-sunken`). It is now `#626B72`
(4.50:1 at worst). Neither change is visible; both were the difference between
a passing system and a failing one.

### The one colour — claret

Claret is the only hue with a voice. It is used for a wine that is scarce, a
window that has closed, and an action that cannot be undone. Nothing else.

**On dark, claret fills; pink speaks.** This is the hardest rule in the
document and it comes from measurement. The old `dark-primary` `#B01230`
measured **2.84:1 on `dark-canvas` and 2.48:1 on `dark-surface-raised`** — it
failed not only as text but as a *fill*, meaning a claret button was not
findable as a shape against its own ground, let alone readable. `#B01230` is
retired from Nocturne entirely.

- A claret **fill** on dark is `dark-primary` `#D01A3C` — 3.24:1 against the
  worst ground, so the shape is findable, with `#FFFFFF` on it at 5.39:1.
- Claret as **text or a mark** on dark is `dark-risk-ink` `#F2879C` — 7.26:1
  at worst. A red number, a red icon, a red rule: all pink, never claret.

On Daylight the reverse holds and needs no special pleading: `primary`
`#96122A` reads at 7.20–8.69:1 on every ground and can be either fill or ink.

**Claret is not the primary-action colour.** It was doing four jobs at once —
brand, primary CTA, urgent status, destructive action — and when everything
urgent is red and every primary button is red, urgency stops meaning anything.
The highest-emphasis button is now the highest-contrast neutral: an ink fill
(`ink` on Daylight, `dark-ink` on Nocturne) with the canvas colour as its
label, at 17:1. Claret fill is reserved for destructive and scarcity. Red now
means *stop*, and it means it every time.

### Champagne — `#E6DCAE`, Nocturne only

One warm mark, and the only one. It carries the active state, the signature,
and the focus ring. At 12.67–14.51:1 on every dark ground it is the most
legible thing in the room, which is the point: it marks *where you are*.

It has no Daylight counterpart and must never be given one — `#E6DCAE` on
white measures **1.26:1**. Anything champagne-filled takes `dark-canvas` as its
ink (14.51:1), never a light ink.

The utility that carries it is **`mark`** — the "you are here" colour: the
active nav tab, the logo's second syllable, the signature. It resolves to
champagne on Nocturne and to claret on Daylight, which is the only reason the
token can exist in both rooms at all. `accent` is a separate token and is
bone on Nocturne: a link should be the most readable thing on the line, not the
most coloured one.

### Status

Four states, and their meaning is carried by the word first and the colour
second. Every ink/wash pair below is measured; all clear 4.5:1.

| State | Nocturne ink / wash | Daylight ink / wash |
|---|---|---|
| Drink now | `#8FD9AF` on `#0F2419` — 9.88:1 | `#215C3C` on `#E4F0EA` — 6.75:1 |
| Hold | `#A9CFEA` on `#0D1D2A` — 10.44:1 | `#22506F` on `#E3EEF6` — 7.29:1 |
| At peak | `#EEF1F4` on `#1F242A` — 13.78:1 | `#0B0D10` on `#E8EAEC` — 16.13:1 |
| Window risk | `#F2879C` on `#2A0A11` — 7.58:1 | `#96122A` on `#F7E4E8` — 7.12:1 |

"At peak" is deliberately achromatic. It is the good, quiet, common state, and
it should not compete for attention with the two states that need action.

There is **no `info` hue and there must not be one.** An informational message
is not a fifth wine condition; it takes the achromatic "at peak" treatment. A
fifth colour would dilute the thesis to buy nothing.

The Daylight "drink now" green was `#2E7D52`, which measured 4.17:1 on
`surface-sunken` and 4.37:1 on `wash`. It is now `#2C774E` (4.52:1 at worst).

### The brown and cream law

Four tests, enforced by `scripts/check-design-palette.mjs`, which exits 1 in
CI. A ban nobody can run is a preference.

1. Any neutral darker than `#404040` must satisfy **B ≥ R**. Brown is a dark
   warm neutral; this makes one impossible.
2. Any neutral lighter than `#C0C0C0` must satisfy **R − B ≤ 4**. Cream is a
   light warm neutral; this makes one impossible.
3. Claret must satisfy **B > G** — pink-leaning, never peach-leaning. A red
   that rotates toward orange is halfway to brown.
4. Champagne must satisfy **|R − G| ≤ 12** *and* stay light (max channel
   ≥ `#C0`), so it can only ever be a bright mark on a dark ground. A warm
   mid-tone is exactly how brown starts.

## The contrast law

Every pair in this system is measured, not judged by eye. The rules:

- **Text needs 4.5:1** against the ground it actually sits on — which for a row
  means `surface-raised`, not `canvas`, because rows get hovered.
- **A control's boundary needs 3:1.** A control you cannot see is a control you
  cannot find.
- **A focus indicator needs 3:1 and must be solid.** No alpha.
- **A fill needs 3:1 against its ground** before you worry about the label on it.

### Load-bearing lines versus decorative rules

The audit's blunt version of this rule was "every hairline must hit 3:1". That
is wrong, and following it would wreck the room: a rule at the alpha required
to hit 3:1 on `#07080A` is **0.37** — `#5C5E61`, which is not a hairline, it is
scaffolding. WCAG 1.4.11 does not ask for it either; it exempts boundaries that
are purely decorative.

So the system splits the roles, and a reviewer can tell them apart with one
test:

> **Set the line to `transparent` in DevTools. If any control, state, hit area,
> data mark or relationship becomes ambiguous, it is load-bearing. If nothing
> operational changes, it is decorative.**

- **`rule` / `dark-rule`** (0.09 alpha) — decorative. Row dividers inside a list
  where the whole row is one target, keylines on a card the surface already
  defines, separators between already-padded rows. These stay quiet by design
  and are exempt.
- **`edge` / `dark-edge`** (`#7C8893` / `#757F88`, solid) — load-bearing. Input
  and select boundaries, unchecked checkbox and radio outlines, slider tracks
  and thumbs, selected-state marks, chart strokes carrying data, any tap target
  whose extent is not otherwise visible. 3.00–3.62:1 on Daylight, 4.29–5.03:1
  on Nocturne. Never alpha — an alpha border changes ratio with whatever is
  behind it, so it cannot be guaranteed.

Today every input in the app uses `border-ink/25`, which measures **2.03:1 on
dark and 1.69:1 on light**. Every text field in Terroir currently has a
boundary you are not able to see. That is what `edge` exists to fix.

### Focus

One focus token, solid, and one recipe: `2px solid` at `2px` offset, on
`:focus-visible` only.

- Nocturne: `dark-focus` `#E6DCAE` — 12.67–14.51:1.
- Daylight: `focus` `#96122A` — 7.20–8.69:1.

The codebase currently runs **two competing focus idioms**: an outline
(184 uses) and `focus:ring-2 focus:ring-accent/25` (47 uses). The ring measures
**1.59:1 on dark and 1.54:1 on light** — it is not a weaker indicator, it is
effectively no indicator, and it fails WCAG 2.2 SC 2.4.11. It also fires on
`:focus` rather than `:focus-visible`, so it appears on mouse clicks too. The
ring idiom is retired; every one of those 47 call sites moves to the outline.

## Typography

Source Serif 4 for display, headings and wine names. Source Sans 3 for
everything you operate. Source Code Pro for bin codes. Ephesis for the
signature. The three text faces were drawn as one superfamily, which is why
they sit together without negotiation.

Bodoni Moda, Archivo and Courier Prime are retired. Bodoni is a Didone: its
defining feature is extreme stroke contrast, and its hairlines are the thinnest
marks in the family. On a dark ground, light type undergoes irradiation — the
light bleeds outward and eats precisely those hairlines. A Didone is the worst
possible class of face for a black interface, and it fails hardest at exactly
the sizes this app lives at. Source Serif 4 carries a **variable optical-size
axis (8–60)**, so one family redraws itself for a 13px caption and a 72px hero
rather than using one drawing for both.

Wine names are set in **sentence case.** Wide-tracked capitals were the first
instinct, taken from the brand marks in the reference set; rendered at real
sizes they read as a film poster rather than as a cellar book. Capitals survive
only at 11px, as labels.

### The scale, and why the last one failed

The previous scale was bypassed. Across 143 files there were **262 uses of the
token scale and roughly 1,050 arbitrary `text-[Npx]` classes** — an 80% bypass
rate. That is not a discipline problem; a scale that gets ignored four times out
of five is a scale with the wrong steps in it.

Two roles were missing and one was over-specified:

- **14px had no token at all**, and was written by hand 239 times — the second
  most common size in the app. 13px is too tight for a form field and 15px too
  loose for a table row, so every input, menu and data cell reached for a
  literal. It is now `control`, and it is the default for anything you tap,
  type into, or read inside a row.
- **10px had no token** and was written 31 times. It is now `micro`, with a
  hard limit: never for anything a sommelier must read in order to act.
- **`ledger` was locked to `0.04em` tracking**, so anyone needing a plain 12px
  timestamp had to write `text-[12px]` — 225 times. Tracking now belongs to
  `caption`, which is the uppercase role that actually needs it. `ledger` is
  plain.

17px was already in the scale as `body-lg` and did not need adding; the audit's
suggestion to add a `title-sm` at 17px would have created a duplicate role.

**Monospace is for codes, not for numbers.** `font-mono` currently appears 165
times, including on quantities and prices. Prices, vintages, counts and
percentages are Source Sans 3 with `font-variant-numeric: tabular-nums`, which
aligns them in a column without making them look like machine output. Source
Code Pro is for bin codes and identifiers only.

### Enforcement

The scale is not a suggestion, and this is the mechanism that makes it hold:

- `check-design-token-sync.mjs` — the DESIGN.md frontmatter and the CSS
  `@theme` block must agree. Fails on a missing, renamed or divergent token.
- `check-design-typography.mjs` — no arbitrary `text-[…]`, no inline
  `fontSize`, no `font-mono` outside the code roles.
- Both run from a **fingerprinted baseline** of today's violations. Any new
  violation fails; migrated lines drop out of the baseline until it hits zero.
- `check-design-contrast.mjs` — computes the WCAG ratio of every pair named in
  this document from the frontmatter itself. Text 4.5:1, fills 3:1, load-bearing
  boundaries 3:1, focus 3:1. `rule` is excluded by name, because 1.4.11 exempts
  it and forcing it would produce scaffolding. The claim that "every pair in
  this system is measured" is only true while this script runs.
- All three exposed as `pnpm check:design` and wired into CI, alongside the
  existing `check-design-palette.mjs`. Four gates, one command.

## Spacing, rhythm and density

The scale keeps its current values — `2xs` 2, `xs` 8, `sm` 14, `md` 18, `lg` 24,
`xl` 36, `2xl` 48, `3xl` 80 — with `3xs` 4px added to absorb the handful of
`gap-1` and `gap-[3px]` strays.

The audit proposed renumbering it to a base-4 progression (`sm` 14→12, `md`
18→16, `xl` 36→32). It is a tidier scale and it is the wrong move here: there
are **2,768 named spacing utility uses across 115 files**, of which **1,667 sit
on the three tokens that would change value**. Renumbering them silently is not
a migration, it is 1,667 unreviewed layout changes. `px-md`, `gap-md` and `py-md`
do not carry the same intent and cannot be shrunk as a group.

If the scale is ever renumbered, it is rename-and-migrate: pin the current
pixel values under transitional names, codemod to them with zero visual change,
introduce the new names, then migrate by component recipe — control padding, row
padding, card padding, section gap — never by global search and replace.

### Density

Three tiers, anchored to what the app already does rather than to a theoretical
grid. The measured cellar row today is ~82.5px, which yields about seven rows
below the sticky masthead on a 390×844 phone. That is the right number, so
`relaxed` is calibrated to it.

| Tier | Row | Vertical pad | Type | Use |
|---|---|---|---|---|
| `compact` | 48px | 8px | `ledger` | Stock counts, reconciliation ledgers |
| `standard` | 64px | 14px | `control` | Bin manager, scan review, price tables |
| `relaxed` | 84px | 18px | `body-lg` | The cellar list, anywhere with a thumbnail |

Every tier clears the 44px touch floor. Density is a property of the *view*, not
of the breakpoint — a phone can show a compact ledger and a desktop can show a
relaxed list.

## Rows and columns

Six bespoke `grid-template-columns` and ten raw `<table>` elements are in
production, so a sommelier moving between `/cellar`, `/bins` and
`/price-comparison` gets three different column alignments, three type sizes and
three hover behaviours for the same kind of information.

The fix is **one typed column contract with several renderers** — not one
component with enough boolean props to impersonate five products. The five call
sites are genuinely different shapes: the cellar has section grouping and
drag-and-drop, bins replaces a row with a full-width edit form, price comparison
spans one wine across many distributor rows, scan review is an editable
spreadsheet, and reconciliation history is a disclosure hierarchy. A single
`DataGrid` cannot be all of those honestly.

```ts
type Density = "compact" | "standard" | "relaxed";
type Align = "start" | "center" | "end";
type MobileSlot = "media" | "eyebrow" | "title" | "meta" | "status" | "trailing";

type CollapseRule =
  | { mode: "show"; slot: MobileSlot; order: number; maxLines?: 1 | 2 }
  | { mode: "hide"; preserveInAccessibleName?: boolean };

interface DataColumn<T, ColumnId extends string, SortKey extends string> {
  id: ColumnId;
  header: React.ReactNode;
  width: { minPx: number; idealPx?: number; maxPx?: number; grow?: number };
  align: Align;
  /** Tabular Source Sans, not monospace. */
  numeric?: boolean;
  truncate: "none" | "one-line" | "two-line";
  sort: false | { keys: readonly SortKey[]; value(row: T): string | number | null };
  mobile: CollapseRule;
  cell(row: T): React.ReactNode;
}
```

The renderers that consume it: a **flat row** renderer (cellar, bins), a
**grouped comparison** renderer (price comparison, which needs real row spans),
and an **editable form-grid** renderer (scan review). Grouping, drag-and-drop
and lineage disclosure compose *around* the flat row rather than being absorbed
into it.

### Column rules

- Names and places are **left**, truncated to one or two lines by an explicit
  `truncate` — never by accident.
- Quantities, prices, vintages, percentages are **right**, tabular, in Source
  Sans 3.
- Bin codes and identifiers are **left**, Source Code Pro.
- Status chips get a fixed-width column so the eye can scan straight down them.
- Separation is a decorative `rule`, never zebra striping. Alternating fills on
  a near-black ground produce visible luminance banding on OLED.
- Hover is a `surface-raised` fill; selection is `surface-raised` plus a 2px
  claret left edge. Never both a lift and a colour change.
- Sticky headers use the `sticky` layer, `caption` type, and a `rule-strong`
  bottom border.

### How a row collapses

Not at `md:`. Collapse **at the point the columns stop fitting**, measured per
view, using a container query — a nine-column price table and a two-column list
do not become unusable at the same width. The cellar row at 390px (354px of
content) becomes:

```
┌──────────────────────────────────────────────────────────┐
│ PRODUCER · VINTAGE · REGION                     BIN CODE │  eyebrow + meta
│ ┌────┐                                                   │
│ │IMG │  Wine name, allowed to run to two lines      ×14  │  media + title + trailing
│ └────┘                                                   │
│ [ Drink now ]                                            │  status, own line
└──────────────────────────────────────────────────────────┘
```

Status gets its own line rather than competing with the title. A selection
checkbox takes 44px from the leading edge and **must not** push the title back
to one line. No horizontal scrolling, ever — the bins table currently exposes a
720px-wide scroll surface on a 390px phone with no phone row at all.

## Controls

Before specifying a control, check whether it exists. Two of the three the
audit called "missing" were already in the codebase, and the third turned out
to be the wrong control for the task.

- **Stepper.** `QtyStepper` exists at
  `src/app/(app)/scan/components/field-inputs.tsx:227`. It is scan-shaped: it
  floors at 1 and commits immediately, so it cannot count a bin down to zero.
  Generalise it with explicit `min`, `max`, `step`, `allowEmpty` and `onCommit`
  rather than writing a second one. Long-press acceleration is opt-in, not the
  default.
- **Segmented control.** The cellar List/Grid toggle exists at
  `cellar-shell.tsx:635` as an `aria-pressed` pair. Promote it to a proper
  radiogroup and standardise it. Atlas is a navigation destination, not a third
  segment.
- **Range slider — do not build one for vintage.** The vintage filter offers
  only the vintages actually present in the cellar
  (`cellar-filter-sheet.tsx:138`). A continuous slider would invent stops for
  years with no bottles behind them and make an exact year harder to hit, not
  easier. Paired selects are the right control; add presets if the interaction
  needs shortening. A dual-handle range is appropriate for **price**, which is
  genuinely continuous — and only once a price filter actually exists.

Any control this system does add is specified with: 44px minimum hit bounds
(expanded with a transparent pseudo-element where the visual is smaller), a
solid `edge` boundary at 3:1, the standard focus outline, and a disabled
treatment that uses the disabled *tokens* rather than container opacity —
`opacity: 0.5` on a wrapper dims the border and the focus ring along with the
label, which is how a disabled control becomes an invisible one.

## Mobile

The real budget on a 390×844 phone, with `viewportFit: "cover"` already set:

| | |
|---|---:|
| Viewport | 844px |
| Header | 54px |
| Top safe area (unreserved today) | 47px |
| Bottom tab bar | 64px |
| Bottom safe area | 34px |
| Scroll band | **692px** |
| Clear of the FAB (y 674–730) | **620px** |
| Below the sticky cellar masthead | **640px** |

At the `relaxed` 84px row that is about seven rows, or roughly seven fully
unobstructed ones outside the FAB's corner. That is a workable density and it
does not need to be compressed.

**The header does not reserve the top safe area.**
`src/app/(app)/layout.tsx:27` is `sticky top-0 h-[54px]` with no
`env(safe-area-inset-top)`. Installed as a PWA on any notched iPhone, the brand
mark and the settings control sit under the Dynamic Island. This is the single
worst mobile defect in the app.

Rules:

- The header reserves `env(safe-area-inset-top)`; every bottom sheet, drawer
  and fixed bar reserves `env(safe-area-inset-bottom)`. There are currently six
  different hand-written formulas for this (`+ 1rem`, `+ 8px`, `+ 12px`,
  `+ 80px`, bare). They become one set of chrome tokens.
- Header, masthead and search overlay offsets come from the `chrome` tokens in
  the frontmatter — not from `54px` in one file and `56px` in another.
- **44px is the touch floor and it is correct.** It matches Apple's HIG, the
  FAB is already 56px and tab bars 64px, and cellar rows are ~82px. Do not bulk-
  convert the 265 existing `min-h-11` uses to 48px. Do fix the compact sticky
  controls that fall to 36px (`h-9`) at `cellar-shell.tsx:374` and `:616`.
- Primary filter and sort live in a **bottom sheet**, in the thumb zone. A
  sommelier holds a bottle in one hand; the top 20% of a 6.1" screen requires
  regripping the phone.
- Every scrollable region inside an overlay sets `overscroll-behavior: contain`.
  Only the add-wine modal does today, so scrolling to the end of the filter
  sheet or the wine drawer chains into the page behind it.
- **Breakpoints are container-driven, not device-driven.** Adding `sm`/`lg`/`xl`
  tiers to the existing lone `md:` does not choose correct thresholds; it just
  adds three more places to guess. Each view declares its own minimum viable
  width and switches mode there.

## Elevation and depth

Four levels, and depth comes from ground value first, shadow second.

0. **Ground** — `canvas`. The page.
1. **Card** — `surface`, a decorative `rule`, `shadow-card`, `lg` radius.
2. **Raised** — `surface-raised`. Hover and selection. No shadow change.
3. **Glass** — floating chrome only: sticky header, drawers, dialogs, toasts.
   `blur(20px) saturate(1.2)` over the glass token, with a `glass-edge` border.
   **Never glass on glass**, and never more than two glass layers composited at
   once — three stacked `backdrop-filter` layers over a 500-row list is a
   measurable scroll-frame cost on mid-range phones.

## Layers

Named, because `z-50` currently means both "toast" and "modal", so whether
feedback appears above or below a dialog depends on DOM order, and one dialog
has already escaped to `z-[60]` to win that race.

`base` 0 · `sticky` 10 · `chrome` 20 · `drag` 30 · `overlay` 40 · `dialog` 50 ·
`toast` 60. Nothing outside this ladder.

A dragged row **cannot** be raised out of a clipping ancestor by z-index: the
cellar's section cards are `overflow-hidden` (`cellar-list.tsx:769`) and the
dragged row sets `zIndex: 10` locally (`:831`), so it is clipped at the section
boundary no matter what. Drag renders through a **portalled overlay** on the
`drag` layer.

## State

Every interactive component implements all eight. Missing states are the most
common source of "the app feels unfinished".

| State | Ground | Ink | Boundary |
|---|---|---|---|
| Default | `surface` | `ink` | `rule` |
| Hover | `surface-raised` | `ink` | `rule-strong` |
| Pressed | `surface-sunken` | `ink` | `rule-strong` |
| Focus | unchanged | unchanged | `focus`, 2px solid, 2px offset |
| Selected | `surface-raised` | `ink` | 2px claret leading edge |
| Disabled | `surface` | `ink-disabled` | `rule` — never container opacity |
| Loading | `surface-sunken` skeleton | — | none, plus a live region |
| Error | `risk-wash` | `risk-ink` | `edge`, plus `aria-invalid` and a linked message |

Two known breaches of this contract:

- **Validation that cannot appear.** `VintageInput` and `MoneyInput` only render
  their error when given an `id` (`field-inputs.tsx:153`, `:213`). The desktop
  scan table passes neither `id` nor `label` (`scan-review.tsx:305`, `:308`), so
  an invalid vintage is silently coerced to NV with no message. The mobile cards
  pass IDs and behave correctly. An error state that is reachable on one
  viewport and not the other is a data-integrity bug, not a styling one.
- **Toasts announce wrongly.** The container is `aria-live="polite"` but every
  item carries `role="alert"` (`src/lib/toast.tsx:60`, `:63`), which is
  assertive — so a success confirmation interrupts a screen-reader user
  mid-sentence. Success and info are `role="status"`; only errors are alerts.
- **Dirty work is discarded silently.** `edit-metadata-modal.tsx` computes
  `dirty` and then lets Escape, the close button and Cancel all call `onClose`
  directly (`:59`, `:320`). Any surface that can compute `dirty` must confirm
  before discarding.

## Motion

`fast` 120ms for state colour, `normal` 200ms for entrances and layout, `slow`
320ms for sheets and drawers. `ease-standard` for entrances, `ease-exit` for
dismissals. Nothing animates without a token.

Everything respects `prefers-reduced-motion: reduce`, which is already wired
globally in `globals.css` and must stay.

## Iconography

Lucide, on a **16 / 20 / 24px** optical grid. Nothing at 12px — a 12px icon on
a near-black ground suffers the same irradiation that killed the Didone, and
it is currently used 38 times.

**Two stroke weights only: 1.75 for default, 2.25 for a filled or active
context.** There are seven in the codebase today (0.5, 1.5, 1.75, 2, 2.25, 2.5,
3), and the reconciliation screen alone uses 1.5 and 2.5 within one view. Stroke
weight is a legibility variable on dark, not a decorative one.

Icons are never the sole carrier of meaning; every icon-only control has an
accessible name.

## Photography

The one place warmth is allowed — and the app currently has three incompatible
treatments for it: square `object-cover` thumbnails that crop tall bottles
(`wine-thumb.tsx:60`), a 2:1 banner crop in the drawer
(`wine-detail-drawer.tsx:481`), and a tall `object-contain` stage on the detail
page (`wine-detail-view.tsx:101`).

Three named recipes, one mat:

- **Mat.** Every image sits on a cool neutral mat (`surface-raised`), never on
  the raw canvas. This is what stops a white-background supplier label shot from
  glaring as a bright rectangle, and what stops a dark bottle on black from
  disappearing.
- **`label`** — square, `object-cover`, `md` radius. Row thumbnails, gallery
  tiles.
- **`bottle`** — 3:4 portrait, `object-contain` on the mat, `lg` radius. Detail
  stages. Bottles are tall; cropping them square is why they read as debris.
- **`plate`** — full-bleed `object-cover` with a bottom-up scrim
  (`linear-gradient(0deg, canvas 0%, transparent 62%)`) so type stays legible
  over any image. Mastheads only.

Supplier product shots arrive on white. They are matted, never composited onto
the canvas directly, and never auto-inverted.

## Formatting

One formatting module, one restaurant locale and currency context. Today there
are nine bare `toLocaleString()` calls, which render according to whichever
locale the sommelier's browser reports — so the same price can appear as
`1,234.00` on one device and `1.234,00` on another — plus five different
explicit configurations, a hardcoded `$` with two decimals in price comparison,
zero decimals in the gallery card, and a hardcoded `en-US` in reconciliation.

- Money: the restaurant's currency, two decimals in ledgers and purchasing,
  zero in browse surfaces. Never a bare `$`.
- Counts and vintages: grouped, tabular, never monospace.
- Dates: the restaurant's locale, never the browser's.
- **The 100-point critic score and the 1–5 crowd average are different
  numbers.** Never show either bare; always label which one it is.

## Truncation

Producer, region, wine name and bin are all single-line truncated in the cellar
row (`cellar-list.tsx:933`), and reconciliation notes are truncated with no way
to expand (`reconcile/history/page.tsx:335`). These are records, not captions.
Anything truncated is reachable in full — by wrap, disclosure, tooltip or
detail view — and the accessible name always carries the untruncated text.

## Print

The global print rule sets margins and forces a white ground but does not
suppress the app header, the bottom tab bar or the FAB, so printing an internal
report can put fixed app chrome across the page. Print hides all chrome, drops
to Daylight, expands every truncation, and prints tables as tables.

## RTL

Not currently viable — layout uses physical `left`/`right` throughout and the
variance chart hardcodes oldest-to-newest as left-to-right. New work uses
logical properties (`ms-`/`me-`, `ps-`/`pe-`, `start`/`end`) so this stays
merely unfinished rather than becoming more expensive.

## Do's and don'ts

**Do**

- Let the photograph be the warm thing.
- Set wine names in sentence case, and put the producer above the name.
- Right-align every figure and make it tabular.
- Use the word *and* the colour for status.
- Reserve the safe areas.
- Measure the pair before you ship the colour.

**Don't**

- Don't tint a neutral warm. That is the process that makes brown.
- Don't put claret text on a dark ground — use pink.
- Don't make the primary button red. Red means stop.
- Don't use an alpha focus ring, or an alpha border on a control.
- Don't set a size in `text-[Npx]`. If the role is missing, add the role.
- Don't reach for monospace to make a number look precise.
- Don't add a fifth status colour.
- Don't build a control before checking whether it already exists.
