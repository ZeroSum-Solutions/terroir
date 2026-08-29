---
version: alpha
name: Terroir — Cantina
description: A wine cellar in two rooms — a cream tasting room by day, a lacquered gold-black cellar by night. High-contrast Didone display over an engineered grotesque, one burgundy anchor in both modes, champagne-gold reserved for the dark, cards that sit a step above a tinted ground. Brown is banned everywhere.
colors:
  primary: "#722f37"
  primary-hover: "#5a252c"
  canvas: "#f2ede3"
  surface: "#fbf9f4"
  surface-sunken: "#eae3d5"
  ink: "#1d1b16"
  ink-soft: "#343226"
  grey: "#666459"
  hairline: "#ded5c4"
  gold: "#786218"
  sage: "#5e6b4b"
  sage-wash: "#e7e6d6"
  sage-ink: "#4c573c"
  powder: "#b2d7e7"
  powder-wash: "#e3ecf2"
  powder-ink: "#3f586c"
  amber: "#7f5f12"
  amber-wash: "#f7efd9"
  blush-wash: "#f0e2dc"
  seal-ink: "#f6f0e3"
  glass: "rgba(251, 249, 244, 0.7)"
  glass-edge: "rgba(255, 253, 247, 0.75)"
  shadow-card: "rgba(30, 26, 16, 0.07)"
  dark-canvas: "#0d0c09"
  dark-surface: "#171512"
  dark-surface-sunken: "#060504"
  dark-ink: "#ede3ce"
  dark-ink-soft: "#d8c9b0"
  dark-grey: "#aea68f"
  dark-hairline: "rgba(237, 227, 206, 0.10)"
  dark-primary: "#8a3a44"
  dark-primary-hover: "#a04751"
  dark-gold: "#c7a165"
  dark-seal-ink: "#f2e7cf"
  dark-glass: "rgba(13, 12, 9, 0.65)"
typography:
  caption:
    fontFamily: Archivo
    fontSize: 11px
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: 0.18em
  body-sm:
    fontFamily: Archivo
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.55
  body:
    fontFamily: Archivo
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.6
  body-light:
    fontFamily: Archivo
    fontSize: 16px
    fontWeight: 300
    lineHeight: 1.6
  subheading:
    fontFamily: Archivo
    fontSize: 19px
    fontWeight: 500
    lineHeight: 1.45
  ledger:
    fontFamily: Courier Prime
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: 0.04em
  heading-sm:
    fontFamily: Bodoni Moda
    fontSize: 26px
    fontWeight: 500
    lineHeight: 1.25
  heading:
    fontFamily: Bodoni Moda
    fontSize: 40px
    fontWeight: 500
    lineHeight: 1.12
  display:
    fontFamily: Bodoni Moda
    fontSize: 76px
    fontWeight: 400
    lineHeight: 1.02
    letterSpacing: 0.01em
rounded:
  control: 10px
  tile: 18px
  card: 20px
  pill: 999px
spacing:
  xs: 8px
  sm: 14px
  md: 18px
  lg: 24px
  xl: 36px
  section: 72px
components:
  page:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
  card-well:
    backgroundColor: "{colors.surface-sunken}"
    textColor: "{colors.ink-soft}"
  nav-glass:
    backgroundColor: "{colors.glass}"
    textColor: "{colors.ink-soft}"
  hero-display:
    textColor: "{colors.ink}"
    typography: "{typography.display}"
  hero-display-accent:
    textColor: "{colors.primary}"
    typography: "{typography.display}"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.pill}"
    typography: "{typography.body-sm}"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "{colors.surface}"
    rounded: "{rounded.pill}"
  button-ghost:
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
  chip:
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    typography: "{typography.body-sm}"
  chip-active:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.canvas}"
    rounded: "{rounded.pill}"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    typography: "{typography.body-sm}"
  eyebrow:
    textColor: "{colors.grey}"
    typography: "{typography.caption}"
  spec-line:
    textColor: "{colors.grey}"
    typography: "{typography.ledger}"
  bin-chip:
    backgroundColor: "{colors.surface-sunken}"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.pill}"
  wax-muted:
    backgroundColor: "{colors.surface-sunken}"
    textColor: "{colors.grey}"
    rounded: "{rounded.pill}"
  wax-neutral:
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.pill}"
  wax-optimal:
    textColor: "{colors.gold}"
    rounded: "{rounded.pill}"
  wax-attention:
    backgroundColor: "{colors.blush-wash}"
    textColor: "{colors.primary}"
    rounded: "{rounded.pill}"
  wax-urgent:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.seal-ink}"
    rounded: "{rounded.pill}"
  gold-mark:
    textColor: "{colors.gold}"
  text-muted:
    textColor: "{colors.grey}"
  divider:
    backgroundColor: "{colors.hairline}"
---

# Terroir — Cantina

> A wine cellar in two rooms. By day: the tasting room — warm cream plaster,
> soft-black ink, one burgundy anchor. By night: the cellar — silky lacquered
> gold-black, champagne type, candle-gold accents. The same bones in both
> rooms; only the light changes. Brown never enters either room (Devin's law,
> 2026-08-26): every near-black keeps its red channel level with green — a
> gold undertone, never a brown one.

**Theme:** light + dark (light default, `prefers-color-scheme` respected,
manual toggle persisted)

Terroir v2 is mixed from six wine identities Devin picked (2026-08-26), decoded
three ways: Gemini 3.1 Pro vision audit, Kimi K3 vision audit, and live-CSS
extraction where the brand has a production site. It replaces the "Beyond
Ordinary" dawn-gallery system (2026-08-19), whose flat white-on-white workspace
Devin rejected: *"hard to distinguish cards and the background — everything
gets lost in white."*

## Overview

Provenance — what each reference contributed:

- **Cantina Simonetti** (Behance, Devin's favorite): the voice. High-contrast
  Didone display caps, cream-on-espresso inversion, engraved heraldic line
  work, typewriter mono for vintages/ABV ("artisanal ledger"), vowelless
  abbreviations. Kimi's decode proposed the exact two-mode token inversion
  this file adopts.
- **Chéri bar & store** (Behance): the dark room. "Never pure white on pure
  black" — deep cassis/espresso grounds with champagne-gold type; gold is the
  constant accent of the dark mode. Sunburst engraving reserved for empty
  states.
- **Maison Mura** (Behance + maisonmura.wine live CSS): merlot ink on ecru
  paper, powder-ice-blue as the info accent, Archivo as the working sans.
- **Maxwell Wines** (maxwellwines.com.au live CSS): the card fix. Canvas is
  tinted bone, cards sit one step *lighter* with a hairline — plus italic
  Didone headlines that end with a period.
- **Can Leandro** (Behance): the ledger card — ivory label-card on dark
  ground, oversized display name allowed to crop, tracked-caps meta line,
  one saturated accent doing all the alarm work.
- **Tito bar de vinos** (Behance): ruthless two-color inversion discipline —
  surfaces are cream or oxblood/espresso, never grey.

Continuity: Terroir's burgundy `#722f37` survives as the single brand
chromatic in both modes (it sits naturally inside every reference's palette
family). Pill geometry, radii, and the spacing scale carry over unchanged.

## Colors

### Light — "Tasting Room" (default)

| Name | Value | Token | Role |
|------|-------|-------|------|
| Burgundy | `#722f37` | `--color-primary` | The only brand chromatic: filled CTAs, active nav, the display accent word, links, focus rings |
| Burgundy Deep | `#5a252c` | `--color-primary-hover` | Hover/pressed anchor |
| Cream | `#f2ede3` | `--color-canvas` | Page ground — warm plaster cream, never white |
| Paper | `#fbf9f4` | `--color-surface` | Cards, panels, inputs — one step lighter than the ground, so surfaces read without borders doing all the work |
| Parchment Well | `#eae3d5` | `--color-surface-sunken` | Table headers, wells, hover washes, bin chips |
| Soft Black | `#1d1b16` / `#343226` | `--color-ink(-soft)` | Text — gold-cast soft black, never `#000`, never brown |
| Stone Grey | `#666459` | `--color-grey` | Muted text, captions, eyebrows — warm-neutral, no brown cast |
| Hairline | `#ded5c4` | `--color-hairline` | Structural 1px lines, warm and visible on cream |
| Antique Gold | `#786218` | `--color-gold` | Premium markers, ratings, subtle emphasis — quiet in the light room |
| Olive Sage | `#5e6b4b` + washes | `--color-sage*` | Transient success feedback only (retired from status chips — Wax & Counter, 2026-08-26) |
| Powder Ice | `#b2d7e7` + washes | `--color-powder*` | Transient/informational feedback only (retired from status chips) |
| Amber | `#7f5f12` / wash | `--color-amber*` | Transient warning feedback only (retired from status chips) |
| Blush | `#f0e2dc` | `--color-blush-wash` | Burgundy-tinted fills: attention chips, risk zones, selected rows |
| Seal Ink | `#f6f0e3` (dark `#f2e7cf`) | `--color-seal-ink` | Text pressed into the filled burgundy wax seal (urgent chips) |
| Card Shadow | `rgba(30,26,16,.07)` | `--shadow-card` | Soft warm lift under cards |

### Dark — "Cellar"

| Name | Value | Token | Role |
|------|-------|-------|------|
| Lacquer | `#0d0c09` | `--color-canvas` | Page ground — silky gold-black lacquer: deep black with a faint gold undertone, never brown, never flat `#000` |
| Raised Lacquer | `#171512` | `--color-surface` | Cards and panels, one step lighter than ground |
| Vault Floor | `#060504` | `--color-surface-sunken` | Wells, table headers |
| Champagne | `#ede3ce` / `#d8c9b0` | `--color-ink(-soft)` | Text — champagne cream, never pure white |
| Smoke Gold | `#aea68f` | `--color-grey` | Muted text — gold-grey, no brown cast |
| Dark Hairline | `rgba(237,227,206,0.10)` (strong `0.16`) | `--color-hairline(-strong)` | Structural lines — champagne alpha, not opaque near-black: the old `#29271e` vanished on lacquer (~1.1:1) and cards fused into one field. Raised surfaces also carry a 1px inset champagne top light (`--t-card-highlight`, 5% alpha) to sell the lacquer sheen |
| Burgundy Fill | `#8a3a44` → `#a04751` | `--color-primary(-hover)` | Buttons/CTAs — brightened for dark contrast, champagne text on top |
| Candle Gold | `#c7a165` | `--color-gold` | The dark room's accent: active nav, ratings, premium markers — gold is the constant of the cellar (Chéri) |
| Badge families | re-tinted washes | `--color-*-wash/-ink` | Same semantic roles, dark-tuned values (see globals.css) |

Mechanics: every token above is a CSS custom property that swaps under
`[data-theme="dark"]` (and under `prefers-color-scheme: dark` when no explicit
choice is stored). Components consume only semantic tokens — a component never
references a mode-specific value.

## Typography

### Bodoni Moda — the cantina voice · `--font-serif`
- **Substitute:** Playfair Display, Prata, Libre Bodoni
- **Weights:** 400, 500, 600 (+ italics), variable with optical sizing
- **Sizes:** 26px, 40px, 76px; wine names in lists at 17px/500
- **Role:** Display and headings — high-contrast Didone, the letterform of
  every reference board. Display headlines in caps carry slight positive
  tracking (Simonetti); the signature move keeps one accent word per display
  headline in *italic* burgundy (Maxwell's italic Didone). Optical sizing
  keeps small wine names sturdy. Never below 17px.

### Archivo — the working voice · `--font-sans`
- **Substitute:** Inter, IBM Plex Sans
- **Weights:** 300, 400, 500, 600 (variable)
- **Sizes:** 11–19px
- **Letter spacing:** -0.005em body; 0.18em uppercase eyebrows; 0.22em
  spaced-caps wordmark
- **Role:** Everything operational — Mura's own production sans. Tall
  x-height grotesque that holds dense data. Weight does hierarchy work
  (300 quiet / 400 default / 500–600 active) before color or size does.

### Courier Prime — the ledger voice · `--font-mono`
- **Substitute:** Space Mono, JetBrains Mono
- **Weights:** 400, 700
- **Role:** Technical wine specs only: vintage years, ABV, bin codes,
  quantities in tables — the typewriter stamp of Simonetti's labels. Tabular
  by nature. Never for prose.

### Type Scale

| Role | Size | LH | Tracking | Token |
|------|------|----|----------|-------|
| caption / eyebrow | 11px | 1.5 | 0.18em, uppercase | `--text-caption` |
| ledger / spec | 12px | 1.4 | 0.04em, mono | `--text-ledger` |
| body-sm | 13px | 1.55 | -0.005em | `--text-body-sm` |
| body | 15px | 1.6 | -0.005em | `--text-body` |
| body-light | 16px | 1.6 | weight 300 | `--text-body-light` |
| subheading | 19px | 1.45 | — | `--text-subheading` |
| heading-sm | 26px | 1.25 | — | `--text-heading-sm` |
| heading | 40px | 1.12 | — | `--text-heading` |
| display | 76px | 1.02 | +0.01em | `--text-display` |

## Layout

**Base unit:** 8px · **Density:** airy in heroes, compact inside data tables.

- Page max-width 1200px; tables may stretch to 1400px.
- Section gap 72px · Card padding 24px · Element gap 14–18px.
- Canonical page anatomy: glass nav → hero (display headline on the canvas,
  no gradient band) → toolbar on a sunken well → card workspace. The old
  dawn-gradient hero is retired; atmosphere now comes from the cream/lacquer
  ground itself.

## Elevation & Depth

| Level | Name | Light | Dark | Purpose |
|-------|------|-------|------|---------|
| 0 | Ground | cream `#f2ede3` | lacquer `#0d0c09` | The room |
| 1 | Card | paper `#fbf9f4` + hairline + `--shadow-card` | raised lacquer `#171512` + hairline + deeper shadow | Panels, cards, list containers |
| 2 | Well | parchment `#eae3d5` | vault floor `#060504` | Table headers, sunken zones inside cards |
| 3 | Glass | `rgba(251,249,244,.7)` blur 18px | `rgba(13,12,9,.65)` blur 18px | Floating chrome only: nav, drawers, modals, toasts |

**The card rule (the reversal that fixes "lost in white"):** cards are
*lighter than the ground* and carry BOTH a hairline and a soft warm shadow
(`0 1px 2px` + `0 6px 20px --shadow-card`). The previous system's "no shadows,
hairline-only separation" law is explicitly repealed — Devin's call,
2026-08-26. Elevation stays quiet (no hard drop shadows, no dark halos), but
a card must never share its exact background with the page behind it.

Glass keeps its recipe (blur 18px, saturate 1.3, 1px glass-edge, one ambient
shadow) and stays rationed to floating chrome. Never glass-on-glass.

## Shapes

Unchanged from v1: pill geometry (999px) for every control — buttons, chips,
inputs, badges; cards 20px; glass tiles 18px; small controls 10px. Nothing
between 10 and 18.

## Components

### Glass Nav
Sticky 54px glass bar. Wordmark in spaced-caps Archivo 600 13px/0.22em —
"TERR" in ink, "OIR" in burgundy (gold in dark mode). Active link burgundy
(light) / candle gold (dark) with a 1px underline.

### Hero
Display headline in Bodoni Moda over the canvas: caps with slight tracking,
one accent word in *italic* burgundy. Eyebrow above in spaced caps. One
Archivo-300 paragraph (max 480px). Stat tiles below as level-1 cards.

### Card (the workspace unit)
Level-1 surface: paper/raised-lacquer ground, 20px radius, hairline border,
`--shadow-card`. Header rows may use the level-2 well. Wine names in Bodoni
Moda 500 17px; metadata beneath in Archivo 300; vintages/ABV/bins in Courier
Prime ledger style.

### Toolbar / Bridge
The filter-chip toolbar sits on a level-2 well strip (parchment / cellar
floor), replacing the old beige bridge band. Chips are transparent pills with
25%-ink borders; active chip = solid ink pill with canvas text.

### Ledger Table
Level-1 card: header row on the level-2 well with spaced-caps labels, rows
hairline-separated, hover wash = well tint. Quantities and vintages in
Courier Prime. No zebra striping.

### Status — Wax & Counter
The one status language (amendment, 2026-08-26 — Devin's D1 call; the
sage/powder/amber badge families are **retired from status duty**). Every
persistent status chip sits on a single urgency scale, styled as a
wax-seal stamp — pill, 10px spaced caps, hairline border:

| Tone | Treatment | Means |
|------|-----------|-------|
| muted | sunken fill, grey text, no border | out of play (no stock, snoozed) |
| neutral | borderless-fill ledger stamp: ink hairline, no fill | routine facts (open bottle, draft, duplicate flag) |
| optimal | gold text + gold hairline + 10% gold fill | a wine at its best; live/published |
| attention | accent text + hairline + 10% accent fill | act soon (drink now, low stock, timing plays) |
| urgent | **the filled seal**: solid burgundy, seal-ink text, faint inner impression ring | act now (past peak, 86'd, money at risk) |

Because `accent` swaps per room, urgency reads burgundy by day and candle
gold by night. Implementation: `StatusChip` (`src/components/status-chip.tsx`)
— never hand-roll a status pill. Sage/powder/amber washes remain in the
palette for transient feedback (toasts, success confirmations) and legacy
surfaces only; migrate to wax tones whenever a surface is touched. Meters
follow the same grammar: risk zones in burgundy tint, target/optimal zones
in gold tint, informational zones in the quiet wash.

### Empty States
The one decorative license: a faint engraved sunburst or vine line-work mark
(Chéri/Simonetti), in hairline tone, behind empty-state copy. Never behind
data.

## Do's and Don'ts

### Do
- Keep burgundy the only brand chromatic in light mode; in dark mode gold
  joins it as the accent of the cellar — burgundy fills, gold highlights.
- Give every card the full level-1 recipe: lighter-than-ground fill +
  hairline + soft shadow. All three, always.
- Set exactly one italic burgundy accent word in display headlines.
- Use Courier Prime for every vintage, ABV, bin code, and quantity — the
  ledger voice is a system signature, not a garnish. This includes stat-tile
  and counter numerals ($ totals, bottle counts): data speaks mono, Bodoni
  is display-only (Kimi audit 2026-08-26).
- Drink-window meters use the two-stop ramp only: `--t-window-ramp-start`
  (warm neutral `#d9d2c4` by day, candle gold by night) → `--t-primary`,
  with the today marker in `--t-window-marker` (burgundy day / gold night —
  burgundy on lacquer fails contrast). No sage/powder/blush stops, no third
  hue, no interpolated olive midpoint.
- Keep neutrals warm in both modes: cream by day, gold-black lacquer by
  night, never cold grey, never `#000` or `#fff` as text or ground.
- Respect `prefers-reduced-motion`; theme switching must not flash.

### Don't
- **Never use brown. Anywhere. Ever** (Devin, 2026-08-26). No espresso
  surfaces, no coffee/chocolate near-blacks, no taupe greys, no bronze-brown
  tints. The mechanical test for near-blacks: red must not exceed green by
  more than ~2 (warmth = a gold undertone, R≈G > B; brown = R clearly above
  G above B). Lighter warm neutrals lean champagne/gold (`#ede3ce`,
  `#aea68f`), never coffee or taupe.
- Don't put white cards on a white ground — the ground is cream or lacquer,
  surfaces are always one step lighter.
- Don't use hard, dark drop shadows; lift is soft and warm.
- Don't use gold as an accent in light mode beyond quiet premium markers —
  it belongs to the dark room.
- Don't bold Bodoni Moda past 600, use it below 17px, or use it for UI
  chrome.
- Don't reintroduce the dawn gradient, powder-blue heroes, or a second
  accent hue. Powder/sage/amber are no longer status colors at all
  (Wax & Counter, 2026-08-26): status chips use only the urgency scale —
  neutral ink, gold optimal, accent attention, filled-burgundy urgent.
  The retired washes survive only in transient feedback and unmigrated
  legacy surfaces.
- Don't hand any component a mode-specific hex — semantic tokens only, both
  modes come free.
- Don't set `text-white` on `accent`, `ink`, `sage-ink`, or `gold` surfaces —
  those tokens go light in the dark room. Inverse chips (tooltips, toasts,
  neutral buttons) use the `surface-inverse`/`on-inverse` pair; sage checks
  pair `sage-ink` with `sage-wash`; solid CTAs stay on `primary`, which is
  burgundy in both modes and safely carries white. The one sanctioned
  `text-white`-on-fixed-dark exception: scrims over live camera video, which
  are media overlays (`black/70`), not themed surfaces.
