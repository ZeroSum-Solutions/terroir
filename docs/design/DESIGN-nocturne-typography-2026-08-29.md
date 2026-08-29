---
version: alpha
name: Terroir — Nocturne
description: A cellar at night. True cool black, bone white, and one claret red — the wine is the only colour in the room. Photography carries the warmth so no surface has to; light comes from the picture, never from the paint. Didone set in wide capitals over an engineered grotesque. Brown and cream are banned outright, in every mode.
colors:
  primary: "#96122A"
  primary-hover: "#B01230"
  accent: "#96122A"
  canvas: "#F4F5F6"
  surface: "#FFFFFF"
  surface-sunken: "#E8EAEC"
  wash: "#EDEFF1"
  ink: "#0B0D10"
  ink-soft: "#33383D"
  grey: "#6B747C"
  hairline: "#DCDFE2"
  hairline-strong: "#C6CBD0"
  seal-ink: "#F7F8F9"
  ready: "#2E7D52"
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
  dark-primary: "#B01230"
  dark-primary-hover: "#D01A3C"
  dark-accent: "#EEF1F4"
  dark-champagne: "#E6DCAE"
  dark-canvas: "#07080A"
  dark-surface: "#0E1013"
  dark-surface-raised: "#161A1E"
  dark-surface-sunken: "#030405"
  dark-wash: "#101317"
  dark-ink: "#EEF1F4"
  dark-ink-soft: "#AEB7BF"
  dark-grey: "#757F88"
  dark-hairline: "rgba(238, 241, 244, 0.09)"
  dark-hairline-strong: "rgba(238, 241, 244, 0.17)"
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
  dark-glass-edge: "rgba(238, 241, 244, 0.14)"
typography:
  display-family: "Source Serif 4, Iowan Old Style, Georgia, serif"
  ui-family: "Source Sans 3, ui-sans-serif, system-ui, sans-serif"
  mono-family: "Source Code Pro, ui-monospace, SFMono-Regular, monospace"
  signature-family: "Ephesis, Snell Roundhand, cursive"
  caption: { size: "11px", line: 1.5, tracking: "0.18em", case: "uppercase", weight: 600 }
  ledger: { size: "12px", line: 1.4, tracking: "0.04em" }
  body-sm: { size: "13px", line: 1.55 }
  body: { size: "15px", line: 1.6 }
  body-lg: { size: "17px", line: 1.6 }
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
  2xs: "2px"
  xs: "8px"
  sm: "14px"
  md: "18px"
  lg: "24px"
  xl: "36px"
  2xl: "48px"
  3xl: "80px"
components:
  plate:
    description: "A full-bleed photographic panel. The only place warmth is allowed. Carries a bottom-up scrim so type stays legible over any image."
    background: "image, cover, center"
    scrim: "linear-gradient(0deg, canvas 0%, transparent 62%)"
    radius: "card"
  card:
    description: "Raised a step above the ground with a hairline and a soft shadow. No inner top-light — that was the lacquer trick and it read as varnish."
    background: "surface"
    border: "1px solid hairline"
    shadow: "shadow-card"
    radius: "lg"
  glass:
    description: "Floating chrome only: sticky nav, drawers, modals, toasts. Never glass on glass."
    background: "glass"
    border: "1px solid glass-edge"
    backdrop: "blur(20px) saturate(1.2)"
  chip:
    description: "A filter or status token. Filled when active, hairline when not. Minimum 28px tall; a chip that is also a tap target gets 44."
    radius: "pill"
    padding: "5px 10px"
    type: "ledger"
  seal:
    description: "The bottle count, laid over a plate. Glass by default; claret fill once the wine is scarce."
    radius: "pill"
    type: "ledger, mono, 700"
  rail:
    description: "The filter sidebar. Sunken relative to results so the eye lands on wines, not controls."
    background: "wash"
    border-right: "1px solid hairline"
    width: "244px"
---

# Terroir — Nocturne

Supersedes **Terroir — Cantina** (2026-08-26), archived at
`docs/design/DESIGN-cantina-2026-08-26.md`.

## Overview

Cantina described a cream tasting room by day and a gold-black lacquered
cellar by night. In practice the cream ground, the Didone paragraphs and the
burgundy anchor landed on the single most common machine-generated look there
is — warm cream, serif display, one earth accent — and every warm neutral in
the ramp drifted toward the brown the document itself banned. The ban was
written; the palette quietly broke it.

Nocturne fixes that at the root rather than by policing hex values.

**The wine is the only colour in the room.** Surfaces are cool, unsaturated,
and nearly black — the ground never competes. Claret appears where there is
actually wine, or actual urgency. Everything else is bone white, greys, and
the photograph.

**Warmth comes from pictures, never from paint.** Cantina tried to make the
interface itself feel candlelit by tinting its neutrals warm. That is exactly
what produced brown. Nocturne makes every painted surface cool and lets
photography — a bottle with a gold rim light, a pour against black — carry all
the warmth. A room lit by its contents.

**The type is scholarly, not theatrical.** A wine list is a reference document
that happens to be beautiful, so it should read like a good press — an
old-style serif in sentence case, set with room. Wide-tracked capitals were the
first instinct, taken from the brand marks in the reference set; rendered at
real sizes they read as a film poster rather than as a cellar book. Capitals
now survive only at 11px, as labels.

### The two rooms

**Nocturne** (dark) is the default and the one the design is drawn for.
**Daylight** (light) is a working mode for a bright dining room at noon — a
cool paper white, not cream. It is a faithful translation, not an inversion:
same structure, same claret, same restraint.

## Colors

### Ground and ink

| Role | Daylight | Nocturne |
|---|---|---|
| canvas | `#F4F5F6` | `#07080A` |
| surface | `#FFFFFF` | `#0E1013` |
| surface-raised | `#FFFFFF` | `#161A1E` |
| surface-sunken | `#E8EAEC` | `#030405` |
| ink | `#0B0D10` | `#EEF1F4` |
| ink-soft | `#33383D` | `#AEB7BF` |
| grey | `#6B747C` | `#757F88` |
| hairline | `#DCDFE2` | `rgba(238,241,244,.09)` |

### The one colour

| Role | Daylight | Nocturne |
|---|---|---|
| primary | `#96122A` | `#B01230` |
| primary-hover | `#B01230` | `#D01A3C` |

Claret is the brand and the alarm, and it is never decoration. It fills a
primary button, marks a wine that is scarce or past its window, and appears in
the wine itself. That is the whole list.

The **interactive accent in Nocturne is bone white**, not claret. On a true
black ground, white is the highest-contrast and most elegant emphasis
available; a saturated red link on near-black is both harder to read and
cheaper-looking. In Daylight the accent is claret, because there white has
nowhere to go.

### Champagne — `#E6DCAE`, Nocturne only

One pale gold, restored after a second pass over the reference set: the wine
app on black uses gold for its active tab and product name, and the printed
wine card uses it for section heads. Cantina was right that the dark room wants
a gold; it was wrong to let that gold's warmth leak into surfaces.

So champagne is bounded to marks, never grounds: **a live section label, an
active facet's rule, a selected tab.** It has no Daylight counterpart — on
white it is invisible, and there the accent is claret. Never a fill, never a
border on a card, never text over 20px.

### Status

Four states, each with a wash and an ink. Semantic colour is separate from
the accent and never borrows it.

| State | Daylight wash / ink | Nocturne wash / ink |
|---|---|---|
| Drink now | `#E4F0EA` / `#215C3C` | `#0F2419` / `#8FD9AF` |
| Hold | `#E3EEF6` / `#22506F` | `#0D1D2A` / `#A9CFEA` |
| At peak | `#E8EAEC` / `#0B0D10` | `#1F242A` / `#EEF1F4` |
| Window risk | `#F7E4E8` / `#96122A` | `#2A0A11` / `#F2879C` |

At peak is deliberately the *achromatic* one — the brightest, quietest state.
A wine at its best does not need a colour; it needs to be legible.

### The brown and cream law

**No surface, wash, hairline, ink or shadow may be brown or cream.** Three
mechanical tests. Every neutral must pass the first two; every claret-family
value must pass the third. `scripts/check-design-palette.mjs` runs them.

1. **Neutral darks must be cool.** For any neutral darker than `#404040`, blue
   must be at least red (`B >= R`). This makes brown arithmetically impossible
   in the dark ramp rather than a matter of judgement.
2. **Neutral lights must be neutral.** For any neutral lighter than `#C0C0C0`,
   red minus blue must be at most 4 (`R - B <= 4`). Cream, tan, sand and ecru
   all fail this.
3. **Claret and its tints must stay pink, not peach.** Claret is a red and is
   exempt from the first two, but blue must exceed green (`B > G`). That is the
   line between a claret wash and a tan one: `#F7E4E8` passes, `#F7E8E4` — the
   same colour rotated four degrees toward brown — does not.
4. **Champagne must stay pale and stay bright.** Exactly one gold is allowed,
   `#E6DCAE`, and it is bounded twice: red and green must sit within 12 of each
   other (`|R − G| <= 12`), so it can never rotate toward orange or tan; and it
   must be light (max channel `>= #C0`), so it can only ever be a bright mark on
   a dark ground — never a surface, a wash, or a mid-tone. That second bound is
   the one that matters: Cantina's brown came from warm *mid-tones*, and this
   makes them impossible while still allowing the gold the references use.

Warm hues therefore survive in exactly three places: **claret** (rule 3),
**champagne** (rule 4), and **photography**, which is not paint. Gold is
permitted only as light *inside an image* — a rim light on a bottle. There is
no gold token, and no surface, border or type colour may be gold.

## Typography

Three faces from one superfamily, plus one signature. Bodoni Moda, Archivo and
Courier Prime are retired.

**Why the old set failed, specifically.** Bodoni is a Didone: its defining
feature is extreme stroke contrast, and its hairlines are the thinnest marks in
the family. On a dark ground, light type undergoes irradiation — the light
bleeds outward and eats precisely those hairlines. A Didone is therefore the
worst available class of face for a black interface, and it fails hardest
exactly where the app lives: 11px labels, 12px figures, 17px wine names. Set in
red on black it stops reading as refined and starts reading as gothic. Courier
Prime failed the same way for the same reason — too light to hold a 12px figure
on black. This was measured, not assumed: candidates were rendered at true
sizes on `#07080A` and compared.

**Source Serif 4** — display, headings, wine names, and large figures. An
old-style text serif with moderate contrast, built for long-form reading, with
a **variable optical size axis (8–60)** — so the same family self-adjusts from
a 13px caption to a 72px hero instead of using one drawing at every size. That
axis is the single most useful technical property for this problem. Set in
**sentence case**, never tracked out.

**Source Sans 3** — every control, label, caption and run of prose. Humanist
rather than mechanical, with open apertures and a generous x-height that
survive 11px on black.

**Source Code Pro** — bin codes only. Things that are codes rather than words.
Prices, counts and vintages use Source Sans 3 with `tabular-nums`.

The three were designed together as one superfamily, which is why they sit
together without negotiation.

**Ephesis** — the signature. One flourish, in champagne, for a cellar's own
name or a curated selection's title. **Never below 32px, never more than once
on a screen, never for anything a person has to read quickly.** A script is a
mark, not an interface.

| Token | Size | Set as |
|---|---|---|
| display | 72px | Source Serif 4, sentence case, `-0.015em` |
| heading | 42px | Source Serif 4, sentence case |
| heading-sm | 27px | Source Serif 4, sentence case |
| signature | 44px | Ephesis, champagne, sparingly |
| subheading | 20px | Source Sans 3 600 |
| body-lg | 17px | Source Sans 3 — or Source Serif 4 for a wine name |
| body | 15px | Source Sans 3 |
| body-sm | 13px | Source Sans 3 |
| ledger | 12px | Source Sans 3 `tabular-nums`, Source Code Pro for codes |
| caption | 11px | Source Sans 3 600, caps, `0.18em` — the only capitals left |

Running prose stays near 65 characters. Headings get `text-wrap: balance`.

## Layout

Page max width 1240px. The rail is a fixed 244px; results take the rest.
Section rhythm is `3xl` (80px) between major bands, `xl` inside them.

Layout is done with grid or flex and `gap` — never per-element margins.
Anything wide (tables, ramps, chip rows) scrolls inside its own container so
the page body never scrolls sideways.

## Elevation & Depth

Four levels, and the change from Cantina is that **depth is now made of
contrast, not varnish**.

0. **Ground** — canvas. Nothing sits at this level but the page.
1. **Sunken** — `surface-sunken`. Wells that hold a photograph, and the filter
   rail. Recessed so the eye goes to content.
2. **Card** — `surface` + hairline + soft shadow. No inset top-light: on a
   lacquer ground that read as a wet varnish edge.
3. **Glass** — floating chrome only. Blur plus a hairline edge. Never stacked.

## Shapes

Radii: 6 / 10 / 14 / 16 / pill. Controls take 10, tiles 14, cards 16.
Nothing between 10 and 14. Tighter than Cantina throughout — a 20px card
corner on a black ground reads soft, and this room is not soft.

## Components

### Plate

The signature element and the reason the palette can be this austere. A plate
is a full-bleed photographic panel with a bottom-up scrim from the canvas
colour to transparent at 62%, so display type can sit over any image and stay
legible. Used for the cellar hero, a wine's detail hero, and empty states.

A wine with no photograph gets a plate too — the sunken well with its monogram
— so an unphotographed catalogue looks deliberate rather than unfinished.

### Card

Surface, hairline, soft shadow, `lg` radius. On hover, lifts 2px and the
hairline strengthens. Never both a lift and a colour change.

### Chip

Filter and status tokens. Filled with claret or a status wash when active;
hairline when not. 28px minimum, 44px when it is a primary tap target.

### Seal

The bottle count over a plate: glass by default, claret fill at two bottles or
fewer. Mono, 700, tabular. Scarcity should read before the name does.

### Rail

The filter sidebar, on `wash` with a hairline right edge. Facet rows are 34px,
counts right-aligned in tabular figures, the colour dot 11px.

### Window ramp

Terroir's own instrument, and the one thing no competitor can draw: a wine's
drink window as a 100px track with a tick for today. Bone at peak, fading to
claret past it. Never gold.

## Do's and Don'ts

**Do**

- Let photography carry every bit of warmth in the interface.
- Keep claret for wine, urgency, and primary action — nothing else.
- Set the serif in sentence case, and keep capitals for 11px labels only.
- Use bone white as the emphasis colour in Nocturne, and champagne only to mark
  what is live: a section label, an active facet, a selected tab.
- Give "at peak" an achromatic treatment; it is the calm state.
- Run the two colour tests on any new value before adding it.

**Don't**

- Don't introduce a brown, tan, beige, sand, ecru or cream value anywhere —
  not in a surface, a wash, a border, a shadow, a chart, a mock-up, an HTML
  explainer, or a generated image prompt. This is the hardest rule in the
  document and it has been broken before.
- Don't tint a neutral warm to suggest candlelight. That is precisely how the
  last palette drifted into brown. Put the candle in a photograph.
- Don't let champagne touch a surface, a wash, a fill, or a mid-tone. It marks;
  it never grounds. Every brown Cantina produced began as a warm mid-tone.
- Don't set the serif in tracked-out capitals; that was the theatrical look.
- Don't use the signature face below 32px, or twice on one screen.
- Don't introduce a Didone or any high-contrast display face for a dark surface.
- Don't use claret as a link colour on the dark ground.
- Don't stack glass on glass, or put an inner top-light on a card.
