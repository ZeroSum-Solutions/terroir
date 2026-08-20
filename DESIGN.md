---
version: alpha
name: Terroir — Beyond Ordinary
description: A daylight gallery for a wine cellar — plaster beige and powder-blue dawn, ultralight editorial serif with an italic accent word, one burgundy anchor, frosted-glass tiles floating on atmosphere.
colors:
  primary: "#722f37"
  primary-hover: "#5a252c"
  canvas: "#ffffff"
  beige: "#ece4da"
  beige-deep: "#e3d9cb"
  bridge-surface: "#faf7f2"
  powder: "#c7d7e9"
  powder-wash: "#e2eaf3"
  powder-ink: "#41586e"
  sage: "#adaa8a"
  sage-wash: "#e6e4d4"
  sage-ink: "#5f5c40"
  ink: "#191919"
  ink-soft: "#212121"
  grey: "#707070"
  hairline: "#e4ded4"
  blush-wash: "#f2e6e2"
  amber: "#8b6914"
  amber-wash: "#fbf3dc"
  glass-white: "rgba(255, 255, 255, 0.55)"
  glass-edge: "rgba(255, 255, 255, 0.7)"
  glass-shadow: "rgba(25, 25, 25, 0.07)"
typography:
  caption:
    fontFamily: Inter
    fontSize: 11px
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: 0.18em
  body-sm:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.55
  body:
    fontFamily: Inter
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.6
  body-light:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: 300
    lineHeight: 1.6
  subheading:
    fontFamily: Inter
    fontSize: 19px
    fontWeight: 500
    lineHeight: 1.45
  heading-sm:
    fontFamily: Cormorant Garamond
    fontSize: 28px
    fontWeight: 400
    lineHeight: 1.25
  heading:
    fontFamily: Cormorant Garamond
    fontSize: 44px
    fontWeight: 400
    lineHeight: 1.1
    letterSpacing: -0.01em
  display:
    fontFamily: Cormorant Garamond
    fontSize: 84px
    fontWeight: 300
    lineHeight: 1.0
    letterSpacing: -0.01em
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
  nav-glass:
    backgroundColor: "{colors.glass-white}"
    textColor: "{colors.ink-soft}"
  hero-display:
    textColor: "{colors.ink}"
    typography: "{typography.display}"
  hero-display-accent:
    textColor: "{colors.primary}"
    typography: "{typography.display}"
  bridge-band:
    backgroundColor: "{colors.beige}"
    textColor: "{colors.ink-soft}"
  glass-tile:
    backgroundColor: "{colors.glass-white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.tile}"
  panel:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
  panel-header:
    backgroundColor: "{colors.bridge-surface}"
    textColor: "{colors.grey}"
    typography: "{typography.caption}"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.canvas}"
    rounded: "{rounded.pill}"
    typography: "{typography.body-sm}"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "{colors.canvas}"
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
    textColor: "{colors.beige}"
    rounded: "{rounded.pill}"
  input:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    typography: "{typography.body-sm}"
  eyebrow:
    textColor: "{colors.grey}"
    typography: "{typography.caption}"
  bin-chip:
    backgroundColor: "{colors.beige}"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.pill}"
  badge-ok:
    backgroundColor: "{colors.sage-wash}"
    textColor: "{colors.sage-ink}"
    rounded: "{rounded.pill}"
  badge-info:
    backgroundColor: "{colors.powder-wash}"
    textColor: "{colors.powder-ink}"
    rounded: "{rounded.pill}"
  badge-warning:
    backgroundColor: "{colors.amber-wash}"
    textColor: "{colors.amber}"
    rounded: "{rounded.pill}"
  badge-risk:
    backgroundColor: "{colors.blush-wash}"
    textColor: "{colors.primary}"
    rounded: "{rounded.pill}"
  badge-danger:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.canvas}"
    rounded: "{rounded.pill}"
  text-muted:
    textColor: "{colors.grey}"
  divider:
    backgroundColor: "{colors.hairline}"
  divider-strong:
    backgroundColor: "{colors.beige-deep}"
  gradient-dawn-stop:
    backgroundColor: "{colors.powder}"
  gradient-dusk-stop:
    backgroundColor: "{colors.beige}"
  glass-hairline:
    backgroundColor: "{colors.glass-edge}"
  glass-ambient-shadow:
    backgroundColor: "{colors.glass-shadow}"
  sage-mark:
    backgroundColor: "{colors.sage}"
    textColor: "{colors.ink}"
---

# Terroir — Beyond Ordinary
> A daylight gallery for a wine cellar: powder-blue dawn settling onto plaster
> beige, an ultralight serif that sets one word in italic burgundy, and frosted
> glass floating on the atmosphere. Mediterranean light, not candlelight.

**Theme:** light

Terroir reads like a gallery in morning light rather than a dashboard. The
palette is borrowed from Normal is Boring's interiors studio — plaster beige,
powder blue, vine sage, warm near-black — with their coral accent replaced by
Terroir's own burgundy, which sits against beige and sage the way wine sits
against plaster and vine. The structure is Cluely's: an atmospheric gradient
hero that resolves into a crisp white workspace, an editorial serif display
over a precise engineered sans, exactly one accent color doing all chromatic
work, and hairline-separated compact UI. The editorial signature comes from
Normal is Boring: an ultralight serif display with a single *italic* word (set
in burgundy), spaced-caps labels, and pill-shaped controls. Glassmorphism is
the high-tech layer, rationed to elements that genuinely float.

## Overview

Provenance:
- Palette: extracted live from normalisboring.es CSS tokens (`--beige #ECE4DA`,
  `--blue #C7D7E9`, `--green #ADAA8A`, `--grey #707070`, black ink); their
  `--red #DB5C59` replaced by Terroir burgundy `#722f37` per Devin
  (2026-08-19: "make that pinkish orange more of the red we have").
- Structure: Cluely style reference via Refero Styles
  (styles.refero.design/style/72da35d5) — atmospheric gradient hero, serif
  display + engineered sans, single accent, compact hairline UI, tinted bridge
  band after the hero.
- Editorial voice: Normal is Boring — ultralight display serif with an italic
  accent word, spaced-caps wordmark and labels, pill geometry.
- Direction chosen by Devin 2026-08-19 ("this is the winner") over two earlier
  candidates (parchment "Cellar Ledger" from Slab; "wine dusk" pure-Cluely
  remap). Approved mockup:
  `~/Inbox/html/terroir-cellar-normal-mockup.html`.

## Colors

| Name | Value | Token | Role |
|------|-------|-------|------|
| Burgundy | `#722f37` | `--color-primary` | The only brand chromatic: filled CTAs, active nav, the italic display word, links, focus rings. One burgundy action per surface |
| Burgundy Deep | `#5a252c` | `--color-primary-hover` | Hover/pressed state of the anchor |
| Chalk | `#ffffff` | `--color-canvas` | Page canvas and card surfaces — the crisp white workspace the gradient resolves into |
| Plaster Beige | `#ece4da` | `--color-beige` | The signature tinted surface: bridge band, bin chips, gradient's warm terminal stop |
| Beige Deep | `#e3d9cb` | `--color-beige-deep` | Tiered dividers inside beige surfaces |
| Bridge Ivory | `#faf7f2` | `--color-bridge-surface` | Table headers, hover washes — the quietest beige tint |
| Powder Blue | `#c7d7e9` | `--color-powder` | The gradient's dawn stop and info accents — atmospheric, never structural |
| Powder Wash / Ink | `#e2eaf3` / `#41586e` | `--color-powder-*` | Info badges (window-closing states) |
| Vine Sage | `#adaa8a` | `--color-sage` | Decorative earthy accent; small marks and illustrative moments |
| Sage Wash / Ink | `#e6e4d4` / `#5f5c40` | `--color-sage-*` | Success/in-window badges — the vineyard green of this system |
| Ink | `#191919` / `#212121` | `--color-ink(-soft)` | Primary text and nav — warm near-black, never `#000` |
| Grey | `#707070` | `--color-grey` | Muted text, captions, eyebrows |
| Hairline | `#e4ded4` | `--color-hairline` | The dominant structural line — warm, beige-derived, 1px everywhere |
| Blush Wash | `#f2e6e2` | `--color-blush-wash` | Burgundy-tinted fills: risk badges, selected rows |
| Amber | `#8b6914` / `#fbf3dc` | `--color-amber(-wash)` | Warnings that are neither info nor risk — used sparingly |
| Glass White | `rgba(255,255,255,.55)` | `--color-glass-white` | Frosted tiles and nav over the gradient, with `backdrop-filter: blur(18px) saturate(1.3)` |
| Glass Edge | `rgba(255,255,255,.7)` | `--color-glass-edge` | 1px border that makes glass read as a pane |
| Glass Shadow | `rgba(25,25,25,.07)` | `--color-glass-shadow` | The system's only shadow: `0 8px 32px` under floating glass |

## Typography

### Cormorant Garamond — editorial voice · `--font-serif`
- **Substitute:** EB Garamond, Editorial New, Lora
- **Weights:** 300, 400 (+ 400 italic)
- **Sizes:** 28px, 44px, 84px
- **Line height:** 1.0–1.25
- **Letter spacing:** -0.01em at display sizes
- **Role:** Display and headings, plus wine names in tables at 17px/500 (the
  one sub-28px exception — wine names are editorial objects, not UI). The
  signature move: display headlines set one word in *italic*, colored
  burgundy ("A cellar beyond the *ordinary*"). Weight 300 at 84px whispers;
  never bold the serif.

### Inter — engineered voice · `--font-sans`
- **Substitute:** Geist, IBM Plex Sans
- **Weights:** 300, 400, 500, 600
- **Sizes:** 11–19px
- **Line height:** 1.45–1.6
- **Letter spacing:** -0.005em body (compact, engineered); 0.18em uppercase
  for eyebrows/labels; 0.22em for the spaced-caps TERROIR wordmark
- **Role:** Everything operational. Weight 300 for whisper-quiet secondary
  copy, 500–600 for active states. Tight tracking keeps it precise against
  the serif's air.

### Type Scale

| Role | Size | LH | Tracking | Token |
|------|------|----|----------|-------|
| caption / eyebrow | 11px | 1.5 | 0.18em, uppercase | `--text-caption` |
| body-sm | 13px | 1.55 | -0.005em | `--text-body-sm` |
| body | 15px | 1.6 | -0.005em | `--text-body` |
| body-light | 16px | 1.6 | weight 300 | `--text-body-light` |
| subheading | 19px | 1.45 | — | `--text-subheading` |
| heading-sm | 28px | 1.25 | — | `--text-heading-sm` |
| heading | 44px | 1.1 | -0.01em | `--text-heading` |
| display | 84px | 1.0 | -0.01em, weight 300 | `--text-display` |

## Layout

**Base unit:** 8px · **Density:** airy in heroes and marketing surfaces,
compact (13.5px cell text, 12–13px paddings) inside data tables.

- Page max-width: 1200px; tables may stretch to 1400px.
- Section gap: 72px · Card padding: 24px · Element gap: 14–18px.
- Canonical page anatomy: glass nav → atmospheric gradient hero (display
  headline + glass tiles) → beige bridge band (filters/toolbar) → white
  workspace (panels and tables). The gradient always resolves INTO the
  workspace; content sections after the bridge are white.

## Elevation & Depth

### Surfaces

| Level | Name | Value | Purpose |
|-------|------|-------|---------|
| 0 | Dawn Gradient | `linear-gradient(172deg, #c7d7e9 0%, #dfe6ea 22%, #f4efe7 55%, #ece4da 100%)` | Hero atmosphere only — never a full-page background |
| 1 | Chalk | `#ffffff` | Workspace canvas and panels |
| 2 | Beige / Ivory | `#ece4da` / `#faf7f2` | Bridge band, table headers, chips — separation by warm tint, not shadow |
| 3 | Glass | `rgba(255,255,255,.55)` + blur 18px | Floating chrome: nav, stat tiles on the gradient, drawers, modals, command palette |

- The workspace is flat: hairlines and beige tints do all separation.
- Glass carries the system's only shadow (`0 8px 32px glass-shadow`).

### The Glass Layer

Rationed like an accent. Rules:

1. **Glass floats; surfaces sit.** Frosting is allowed only on elements layered
   above other content: sticky nav, stat tiles on the gradient hero, drawers,
   modals, command palette, toasts. Never on static content sections.
2. **Recipe:** `background: {colors.glass-white}`,
   `backdrop-filter: blur(18px) saturate(1.3)`, 1px `{colors.glass-edge}`
   border, `0 8px 32px {colors.glass-shadow}`, radius `{rounded.tile}`.
3. **Never glass on glass** — one frosted altitude per stack.
4. **AA against the worst-case backdrop**; add a solid ivory well inside the
   pane when in doubt.
5. **Fallback:** solid `#ffffff` at 92% opacity where `backdrop-filter` is
   unsupported. The design must survive the fallback.
6. Glass stays white — never beige-tinted, never burgundy-tinted.

## Shapes

Pill geometry is the system's signature: buttons, chips, inputs, badges, and
bin tags are all fully rounded (`999px`). Rectangular surfaces are soft —
panels/cards 20px, glass tiles 18px, small controls 10px. Nothing sits between
10px and 18px; the gap is what separates "control" from "surface".

## Components

### Glass Nav
Sticky 54px bar: glass recipe over whatever scrolls beneath, hairline bottom
edge. Wordmark is spaced-caps Inter 500 at 13px/0.22em — "TERR" in ink,
"OIR" in burgundy. Links Inter 400 13px ink-soft; active link burgundy with a
1px underline. Account/context info right-aligned, weight 300 grey.

### Dawn Hero
The one atmospheric moment per page: the dawn gradient (level-0 surface),
eyebrow in spaced-caps grey, display headline in Cormorant 300 at 84px with
exactly one italic burgundy word, one weight-300 Inter paragraph (max 480px),
then a burgundy pill CTA beside an ink-outline ghost pill. Glass stat tiles
sit at the hero's foot, bridging into the workspace.

### Glass Stat Tile
On the gradient only: glass recipe, 18px radius, spaced-caps label in grey,
Cormorant 400 number at 30px, delta line in sage-ink (positive) or burgundy
(needs attention). On white surfaces the same tile renders solid ivory with a
hairline instead of glass.

### Bridge Band
Full-width beige `#ece4da` strip directly after the hero: filter chips
(transparent pills with 25%-ink borders; active = solid ink pill with beige
text), pill search input at 70% white, and the surface's single burgundy pill
button. This band is the only beige structural section per page.

### Ledger Panel
White panel, 20px radius, hairline border. Header row bridge-ivory with
spaced-caps column labels. Rows hairline-separated, hover bridge-ivory; wine
names in Cormorant 500 17px with weight-300 metadata beneath; quantities in
tabular numerals; producer group rows as beige spaced-caps strips. No zebra
striping, no shadows.

### Badges
Pill, 10.5px spaced-caps: sage-wash/sage-ink for in-window; powder-wash/
powder-ink for window-closing (informational); blush-wash/burgundy for
sleepy-capital risk; solid burgundy/white for variance alarms — the only
filled badge, reserved for money-at-risk. Amber only when a warning is
neither info nor risk.

## Do's and Don'ts

### Do
- Keep burgundy as the only brand chromatic; sage and powder are earthy/airy
  support tints, never competing accents.
- Set exactly one italic burgundy word in every display headline — it is the
  brand's editorial signature.
- Use the dawn gradient once per page, always resolving into the white
  workspace; the beige bridge band is the handoff.
- Keep all interactive geometry pill-shaped; keep all surfaces 18–20px.
- Use warm, beige-derived hairlines (`#e4ded4`) for every structural line.
- Let weight do hierarchy work in Inter (300 quiet / 400 default / 500–600
  active) before reaching for color or size.

### Don't
- Don't use Normal is Boring's coral `#DB5C59` or Cluely's blue `#3c83f6` —
  both palettes contributed structure or tint, neither contributes its accent.
- Don't bold Cormorant or use it below 17px; don't use it for UI chrome.
- Don't tint glass beige or burgundy; don't stack frosted surfaces.
- Don't apply shadows to anything except floating glass.
- Don't use pure `#000` text or cool grays; every neutral leans warm except
  powder, which is atmosphere.
- Don't add a second beige band or a second gradient per page — one dawn, one
  bridge, then white.
