# Deterministic miss corpus — measured

**Date:** 2026-09-01 · **Status:** RUN, evidence below · Feeds docs/plans/2026-09-01-tier-2-struct-compile-ops-spec.md §6 decision 4

**Question:** with the two deterministic parsers as they stand today — parseSearchQuery (GET /api/search, global gazetteer) and parseAssistantQuery (GET /api/assistant, this tenant's own vocabulary) — what fraction of a realistic query corpus do they answer, and what does the residual actually look like? This is the "measure what still misses" step the ops spec asks for before any tier-2 provider call is built.

**Method.** `src/lib/wine-intelligence/fixtures/deterministic-miss-corpus.json` (180 hand-written cases across six lenses — sommelier-at-service, guest-at-table, buyer-manager, colloquial-typos, occasion-comparative, multi-constraint — each with an `expected` struct a good deterministic parse should produce) runs through both parsers via `measureCase()` (`src/lib/wine-intelligence/deterministic-coverage.ts`), against `src/lib/wine-intelligence/fixtures/demo-tenant-vocabulary.json` — the ACTUAL distinct country/region/grape values of the "LOCAL SEED - Osteria Scala" demo tenant (252 wines, 7 countries, 66 regions, 162 grape values), built exactly the way `GET /api/assistant` builds it, measured on the local loopback stack. A field counts as recovered if EITHER parser produces it — the two entry points cover different ground (search matches a global gazetteer regardless of tenant stock; the assistant matches only what this tenant actually holds), and the corpus measures the combined deterministic lane, not either parser alone. Five real parser bugs turned up while building this corpus and are fixed in this same slice (see "Bugs found and fixed" below); two could not be fixed safely here and are recorded as `knownWrong` on their case with a reason, per the acceptance test's own rule.

Re-run: `npx tsx scripts/measure-deterministic-misses.ts`. Offline, deterministic, no network/DB/model call.

## Counts

| classification | count | % of 180 | meaning |
|---|---|---|---|
| answered | 97 | 53.9% | every expected field matched |
| partial | 26 | 14.4% | some but not all expected fields matched |
| tier2 | 9 | 5.0% | paraphrase-only, nothing captured |
| tier3 | 45 | 25.0% | occasion / comparative / open-question |
| missed | 1 | 0.6% | nothing captured, not paraphrase-only |
| wrong (unexcused) | 0 | — | must be 0 — the acceptance test enforces it |
| knownWrong (excused) | 2 | — | classifies wrong; reason recorded on the case |

Ratchet baseline (`fixtures/deterministic-coverage-baseline.json`): answered 87 → 97, missed+tier2 17 → 10.

## Bugs found and fixed in this slice

Building the corpus surfaced real precision failures — a parser confidently asserting something the query contradicted, the exact class §2.2 of the ops spec already flagged once for assistant-query.ts's negation handling. Each is fixed with its own failing test, not patched around:

1. **query-parse.ts had NO negation handling at all.** "no reds tonight" filtered TO reds — `colours: ["Red"]`, `understood: true` — the inverse of the question, with total confidence. assistant-query.ts got this fix already (§2.2); it had never been ported to the search parser. Fixed by porting the same backward-lookback negation walk onto this module's own token model (`query-parse.test.ts`, "negation is never read as affirmation").
2. **A trailing comma or period silently broke every match.** `foldTerm()` never stripped punctuation, so "Rioja," and "2016," never matched their gazetteer/vintage patterns — `parseSearchQuery("Rioja, please")` returned an EMPTY parse, `understood: false`, for one of the most ordinary sommelier queries in the corpus. This was not a corpus-only artifact: it broke matching for every field this function gates (country/region/colour/body AND the 4-digit vintage check), for any token immediately followed by punctuation — a common shape in real prose. Fixed in `foldTerm()` (wine-gazetteer.ts).
3. **"$100" was read as the "100% single varietal" idiom.** SINGLE_VARIETAL_PHRASES matched a bare "100" unconditionally, so "a blend from Priorat, over $100" set `blend: false` from the PRICE digits, before the actual word "blend" a few tokens later was ever considered — because normalize() strips the "%" that would otherwise tell "100% Malbec" and "$100" apart. Fixed by checking the raw text for literal "100%" instead of matching a bare digit.
4. **"anything but another Malbec" and "nothin too full bodied" leaked their negation.** Two lexicon gaps in NEGATION_PHRASES/FILLER_WORDS: "another" and "too" are pass-through words with no facet of their own, but sat between a real negation trigger and its target, ending the backward walk one step short; "nothing"/"nothin" were never in NEGATION_PHRASES at all (only "no"/"not" were).
5. **"cured meats" (plural) fell through to the generic "meats" catch-all** instead of the specific Cured Meat pairing value — not false, just far less specific than asked. Added the plural to that phrase's list.

Two cases still classify `wrong` and are excused with `knownWrong` on the case (both real, both deliberately deferred — see the field's own reason for detail):

- **sas-18** — negation POSTPOSED across a relative clause ("that Malbec they didn't love"); the negation-walk design only looks backward from a facet, and this negation trails it by several words. Needs real clause-level parsing, not a lexicon fix.
- **occ-09** — parsePrice's upper/lower comparator regex tests the WHOLE normalized query, not a window around the matched amount, so an unrelated "over" elsewhere in the sentence ("friends over for pasta night") hijacks a lone-figure price band. Real bug; the fix touches every price pattern parsePrice handles and needs its own dedicated test pass.

## Every non-answered case, by classification

### Partial — some fields matched, some missing (26)

| id | lens | query | missing | unrecognized |
|---|---|---|---|---|
| sas-04 | sommelier-at-service | Chilean Cabernet for the beef course tonight | grape | chilean, cabernet, course |
| sas-09 | sommelier-at-service | 2019 Napa Cabernet under $120 | grape | napa, cabernet |
| sas-12 | sommelier-at-service | Tuscan red for the mushroom risotto | region | tuscan |
| sas-15 | sommelier-at-service | Australian Shiraz, full bodied, under $55 | grape | australian, shiraz |
| bym-10 | buyer-manager | do we still have the 2018 Napa Cabernet | grape | still, napa, cabernet |
| bym-11 | buyer-manager | Barossa Shiraz restock check | grape | barossa, shiraz, restock, check |
| bym-15 | buyer-manager | Sangiovese from Tuscany under $18 a glass | grape | sangiovese, tuscany |
| bym-24 | buyer-manager | under 60 for a Tuesday night red | priceMax | tuesday |
| bym-25 | buyer-manager | reds under sixty a bottle for happy hour | priceMax | sixty, happy, hour |
| col-06 | colloquial-typos | chilean sauv blanc | grape | chilean, sauv |
| col-12 | colloquial-typos | an easy drinkin red, nothin too full bodied | body | easy, drinkin, nothin, full, bodied |
| col-17 | colloquial-typos | malbec, mendoza, under 30 pls | priceMax | mendoza, pls |
| col-21 | colloquial-typos | kiwi sauv blanc, crisp | country, grape | kiwi, sauv |
| col-22 | colloquial-typos | aussie shiraz, big n bold | country, grape | aussie, shiraz, big |
| occ-21 | occasion-comparative | zippy white to start the evening with appetizers | pairing | zippy, start, appetizers |
| mco-01 | multi-constraint | a red under 60 to go with the ribeye | priceMax | — |
| mco-05 | multi-constraint | crisp white for oysters, less than sixty | priceMax | sixty |
| mco-07 | multi-constraint | a Burgundy Pinot Noir, 2018 to 2020, not too oaky | vintages | burgundy, not, oaky |
| mco-14 | multi-constraint | Chilean Cabernet, $15 to $25, for burgers | pairing, grape | chilean, cabernet, burgers |
| mco-16 | multi-constraint | zippy rosé for the porch, nothing over 30 | priceMax | zippy, porch, nothing |
| mco-17 | multi-constraint | Austrian Grüner Veltliner, not too acidic, under $40 | grape | austrian, gruner, veltliner, not, acidic |
| mco-23 | multi-constraint | Aussie Shiraz, full bodied, for the BBQ, under 50 | country, grape, priceMax | aussie, shiraz |
| mco-25 | multi-constraint | a Tuscan red that isn't Sangiovese, around $70 | region | tuscan, isnt, sangiovese |
| mco-26 | multi-constraint | cheap Spanish white, 2 for under 40 combined | priceMax | cheap, combined |
| mco-28 | multi-constraint | Loire Sauvignon Blanc, light, cheaper than 35 | priceMax | loire, cheaper |
| mco-29 | multi-constraint | a Chianti that pairs with mushrooms and isn't too expensive | region | chianti, isnt, expensive |

### Tier 2 — paraphrase-only, nothing captured (9)

| id | lens | query | missing | unrecognized |
|---|---|---|---|---|
| sas-16 | sommelier-at-service | something zippy and food-friendly, nothing too pricey | — | zippy, food, friendly, nothing, pricey |
| sas-20 | sommelier-at-service | an easy sipper that won't scare off the in-laws | — | easy, sipper, wont, scare, off, laws |
| sas-27 | sommelier-at-service | nothing from Chardonnay, and keep it under a hundred | priceMax | nothing, chardonnay, keep, hundred |
| gat-16 | guest-at-table | something zippy and refreshing | body | zippy, refreshing |
| gat-17 | guest-at-table | easy to drink, nothing too serious | body | easy, nothing, serious |
| gat-22 | guest-at-table | budget's about 60 for two of us sharing | priceMax | budgets, two, sharing |
| col-19 | colloquial-typos | somethin zippy n refreshing for apps | body, pairing | somethin, zippy, refreshing, apps |
| col-23 | colloquial-typos | champers under 60 bucks | type | champers |
| occ-25 | occasion-comparative | toasting a promotion, bring out something punchy for the table | body | toasting, promotion, out, punchy, table |

### Missed — nothing captured, not paraphrase-only (1)

| id | lens | query | missing | unrecognized |
|---|---|---|---|---|
| gat-14 | guest-at-table | a port for after dinner | type | after |

### Known wrong (excused, reason on the case) (2)

| id | lens | query | missing | unrecognized |
|---|---|---|---|---|
| sas-18 | sommelier-at-service | what would pair better with the lamb than that Malbec they didn't love | negated grape: Malbec was asserted positively | better, they, didnt, love |
| occ-09 | occasion-comparative | friends over for pasta night, an Italian red around $35 | priceMin: expected 28 | friends, italian |

### Tier 3 — occasion / comparative / open-question (45)

| id | lens | query | missing | unrecognized |
|---|---|---|---|---|
| sas-17 | sommelier-at-service | table nine just got engaged — bring out something special | — | table, nine, just, engaged, out, special |
| sas-22 | sommelier-at-service | big juicy red, similar vibe to a Napa Cab but cheaper | — | juicy, similar, vibe, napa, cab, but, cheaper |
| sas-23 | sommelier-at-service | a wine that'll impress my mother-in-law without breaking the bank | — | thatll, impress, mother, law, without, breaking, bank |
| sas-25 | sommelier-at-service | is the Sassicaia better than the Ornellaia for pairing with wagyu | — | sassicaia, better, ornellaia, wagyu |
| sas-26 | sommelier-at-service | what's the crowd-pleaser tonight | — | whats, crowd, pleaser |
| sas-29 | sommelier-at-service | somewhere between a Cab and a Zin, not too tannic | — | somewhere, cab, zin, not, tannic |
| sas-30 | sommelier-at-service | the couple at four wants whatever you'd pour for your own anniversary | — | couple, four, wants, whatever, youd, own, anniversary |
| gat-18 | guest-at-table | we're celebrating our anniversary tonight, what should we get | — | were, celebrating, anniversary |
| gat-19 | guest-at-table | I'd like something like the Opus One we had before | — | opus, one, had, before |
| gat-20 | guest-at-table | anything nicer than a basic house red | — | nicer, basic, house |
| gat-21 | guest-at-table | surprise me with something special for date night | — | surprise, special, date |
| gat-25 | guest-at-table | something that'll go with basically anything we order | — | thatll, basically, order |
| gat-26 | guest-at-table | best bottle you've got for a first date | — | youve, first, date |
| gat-27 | guest-at-table | smoother than the Malbec we had last time | — | smoother, had, last, time |
| bym-26 | buyer-manager | what should I open for a table celebrating a big promotion | — | open, table, celebrating, promotion |
| bym-27 | buyer-manager | I need something impressive to pour for a first date sitting at table 12 | — | impressive, first, date, sitting, table |
| bym-28 | buyer-manager | something like Whispering Angel but a little cheaper | — | whispering, angel, but, little, cheaper |
| bym-29 | buyer-manager | what do we have that's similar to Opus One | — | thats, similar, opus, one |
| bym-30 | buyer-manager | which whites are we sitting on too long | — | which, are, sitting, long |
| col-24 | colloquial-typos | somethin like a Meursault but cheaper | — | somethin, meursault, but, cheaper |
| col-25 | colloquial-typos | anything similar to Opus One | — | similar, opus, one |
| col-26 | colloquial-typos | whats good for an anniversary dinner | — | whats, anniversary |
| col-27 | colloquial-typos | need a bottle to impress my boss, price no object | — | impress, boss, object |
| col-28 | colloquial-typos | drier than the sancerre we had last time | — | drier, had, last, time |
| col-29 | colloquial-typos | whats the best wine you've got | — | whats, youve |
| col-30 | colloquial-typos | somethin special, not sure what, surprise me | — | somethin, special, not, sure, surprise |
| occ-11 | occasion-comparative | tonight's pick? | — | tonights, pick |
| occ-12 | occasion-comparative | our usual, please | — | usual |
| occ-13 | occasion-comparative | what should I open tonight? | — | open |
| occ-14 | occasion-comparative | same as last time please | — | same, last, time |
| occ-15 | occasion-comparative | something like Opus One but a bit cheaper | — | opus, one, but, bit, cheaper |
| occ-16 | occasion-comparative | we just got engaged, bring us something really special | — | just, engaged, really, special |
| occ-17 | occasion-comparative | it's her birthday, pick something she'll absolutely love | — | its, her, birthday, pick, shell, absolutely, love |
| occ-18 | occasion-comparative | give me the opposite of last night's big red | — | opposite, last, nights |
| occ-22 | occasion-comparative | we want something food-friendly for the tasting menu tonight | — | food, friendly, tasting, menu |
| occ-23 | occasion-comparative | our usual bottle for game night, nothing too serious | — | usual, nothing, serious |
| occ-24 | occasion-comparative | the wine we had at Sarah's wedding, if you have it | — | had, sarahs, wedding |
| occ-26 | occasion-comparative | we want a crowd-pleaser for the whole table tonight | — | crowd, pleaser, whole, table |
| occ-27 | occasion-comparative | surprise us with something we haven't tried before | — | surprise, havent, tried, before |
| occ-29 | occasion-comparative | her go-to order, whatever we got her last time | — | her, order, whatever, her, last, time |
| occ-30 | occasion-comparative | same grape as the bottle we had in Tuscany last summer | — | same, grape, had, tuscany, last, summer |
| mco-15 | multi-constraint | give me something as good as Opus One but cheaper | — | opus, one, but, cheaper |
| mco-20 | multi-constraint | what would you pour for a fifth anniversary dinner | — | fifth, anniversary |
| mco-22 | multi-constraint | something special to celebrate a promotion, budget's not really a concern | — | special, celebrate, promotion, budgets, not, really, concern |
| mco-24 | multi-constraint | is the Sancerre more mineral than the Chablis | — | mineral, chablis |

## What a cheap deterministic fix would recover

Evidence, not opinion: each row below is a set of case ids computed straight from the measured results above (see this script), grouped by the SAME underlying lexicon change. None of these are applied in this slice except where already listed under "Bugs found and fixed" — this section is the input to ops spec §6 decision 4, not a decision of its own.

### Read a bare digit as a price when a comparator word is present, even with no "$" (8 cases)

parseAssistantQuery's parsePrice() only reads a number as a price when it is preceded by "$" or followed by "dollars"/"bucks"/"usd" — documented, current behaviour, not a bug. Every case below carries an explicit comparator word ("under", "over", "cheaper than", "about", …) immediately next to a digit sequence, which is as strong a signal as a currency mark. This is the single biggest recoverable group in the corpus. NOTE what this does NOT cover: a handful of other cases spell the number out ("under sixty", "under a hundred") — recovering those needs a words-to-numbers table, a materially bigger lift than dropping the "$" requirement, so they are left in "What only tier 2 recovers" below rather than claimed here.

Cases: gat-22, bym-24, col-17, mco-01, mco-16, mco-23, mco-26, mco-28

### Match a single-word grape name onto the tenant's compound-name value (10 cases)

The tenant's own vocabulary (verified against demo-tenant-vocabulary.json) already holds the expected grape — either that exact value, or as one whole word inside a compound value X-Wines stores as a single string (e.g. "Shiraz" inside "Syrah/Shiraz") — but the query used a shorter, everyday form that bestVocabularyMatch (assistant-query.ts) requires as an exact phrase today. A small grape alias table, the same shape countrySurfaceTerms/regionSurfaceTerms already are, would close this without touching the matching engine.

Cases: sas-04, sas-09, sas-15, bym-10, bym-11, col-06, col-21, col-22, mco-14, mco-23

### Grape names this tenant genuinely does not stock (data gap, not a lexicon gap) (2 cases)

The expected grape is not in the tenant's own vocabulary in any form — no lexicon change recovers these, because the 250-wine demo cellar simply holds no bottling of that grape. Listed for completeness, not as a fix candidate.

Cases: bym-15, mco-17

### Add an adjectival surface term for a region the gazetteer already knows (2 cases)

wine-gazetteer.ts's REGION_TERMS already maps "Tuscany" from "tuscany"/"toscana", but not from the adjective "Tuscan" people actually say ("Tuscan red", "a Tuscan bottle"). One surface term per region recovers the case regardless of whether any tenant stocks that region.

Cases: sas-12, mco-25

### Add a region the gazetteer has no entry for at all (1 case)

Not a missing spelling of a known region — the canonical region itself ("Chianti") is absent from REGION_TERMS. A new entry, not a new surface term.

Cases: mco-29

### Add a colloquial type synonym to an existing phrase list (2 cases)

"champers" (slang for Champagne/sparkling) and "port" (for the Fortified colour the search gazetteer already has a slot for) both name a TYPE_PHRASES/COLOUR_TERMS value that exists today; only the surface word is missing from its phrase list.

Cases: gat-14, col-23

### Add a plural to a singular-only pairing phrase (2 cases)

The same class of gap "cured meat"/"cured meats" was (fixed in this slice, assistant-lexicon.ts) — PAIRING_PHRASES' Appetizer entry lists "appetizer" but not "appetizers".

Cases: occ-21, mco-14

### Read a written-out vintage RANGE, not just the two literal years typed (1 case)

parseVintages has no notion of a range: "2018 to 2020" reads as exactly the two numbers present (2018, 2020), silently missing the implied 2019 in between. This is a small feature, not a lexicon entry — flagged here rather than fixed, since it needs its own design for what "to" means next to a non-price number.

Cases: mco-07

## What only tier 2 recovers

12 of the 38 non-answered, non-tier3 cases are not explained by any cheap fix above — genuine paraphrase, slang, or multi-clause phrasing outside any fixed phrase list, which is tier 2's actual residual job per ops spec §2:

| id | lens | query | unrecognized |
|---|---|---|---|
| sas-16 | sommelier-at-service | something zippy and food-friendly, nothing too pricey | zippy, food, friendly, nothing, pricey |
| sas-18 | sommelier-at-service | what would pair better with the lamb than that Malbec they didn't love | better, they, didnt, love |
| sas-20 | sommelier-at-service | an easy sipper that won't scare off the in-laws | easy, sipper, wont, scare, off, laws |
| sas-27 | sommelier-at-service | nothing from Chardonnay, and keep it under a hundred | nothing, chardonnay, keep, hundred |
| gat-16 | guest-at-table | something zippy and refreshing | zippy, refreshing |
| gat-17 | guest-at-table | easy to drink, nothing too serious | easy, nothing, serious |
| bym-25 | buyer-manager | reds under sixty a bottle for happy hour | sixty, happy, hour |
| col-12 | colloquial-typos | an easy drinkin red, nothin too full bodied | easy, drinkin, nothin, full, bodied |
| col-19 | colloquial-typos | somethin zippy n refreshing for apps | somethin, zippy, refreshing, apps |
| occ-09 | occasion-comparative | friends over for pasta night, an Italian red around $35 | friends, italian |
| occ-25 | occasion-comparative | toasting a promotion, bring out something punchy for the table | toasting, promotion, out, punchy, table |
| mco-05 | multi-constraint | crisp white for oysters, less than sixty | sixty |
