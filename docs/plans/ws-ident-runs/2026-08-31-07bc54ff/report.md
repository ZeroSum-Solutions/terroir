# WS-IDENT linkage run 07bc54ff-f0ac-4f25-94d5-ea56de4f302c

- Date: 2026-08-31T23:19:50.950Z
- Rule: `lwin-xwines-linkage/3 token-equality tail-accounting floors=0.65/0.8/0.64 gap=0.03 margin=0.05`

## Outcomes

- lwin_catalog rows: 211517
- previously decided in this run (resume skip): 0
- processed this invocation: 211517
- abstained, nothing to match (blank producer / no cuvée text): 1090
- accepted (exact join): 15984
- accepted (trigram): 210
- review — ambiguous: 1015, near-floor: 3224, name-mismatch: 9499, tombstoned: 0
- abstained — no candidates: 86393, floor miss: 93088, name-mismatch: 1014
- exact keys contested by >1 corpus row (sent to scored pass): 61
- canonical_wines rows propagated: 0

## Blended-score histogram (rows carrying a score)

- <0.65: 0
- 0.65–0.75: 282
- 0.75–0.85: 2153
- 0.85–0.95: 6663
- 0.95–1.00: 4850

## By country (top 25 by volume)

| Country | Accepted | Review | Abstained |
|---|---|---|---|
| France | 4774 | 3552 | 59229 |
| United States | 2565 | 2753 | 30954 |
| Italy | 3124 | 2350 | 18994 |
| United Kingdom | 7 | 31 | 12252 |
| Australia | 1124 | 884 | 9861 |
| Spain | 629 | 353 | 8172 |
| Germany | 618 | 994 | 7126 |
| South Africa | 702 | 529 | 4051 |
| Portugal | 602 | 393 | 3982 |
| Argentina | 437 | 470 | 3570 |
| New Zealand | 434 | 240 | 3430 |
| Austria | 324 | 249 | 3486 |
| Chile | 501 | 624 | 2588 |
| Canada | 129 | 135 | 3069 |
| Japan | 3 | 1 | 1683 |
| Switzerland | 10 | 23 | 1059 |
| Mexico | 70 | 51 | 956 |
| NA | 0 | 2 | 1050 |
| Luxembourg | 0 | 4 | 900 |
| Greece | 29 | 23 | 538 |
| Hungary | 13 | 12 | 391 |
| Slovenia | 4 | 4 | 364 |
| Lebanon | 24 | 3 | 264 |
| Ireland | 0 | 0 | 290 |
| Israel | 21 | 24 | 191 |
## QA record (identity policy §4)

- **Negative-pair gate: PASS.** `qa-lwin-xwines-linkage.ts negative --n=120 --seed=42`
  against this rule version: 120 same-producer/wrong-cuvée pairs (16 colour,
  104 qualifier), **0 accepted**, 57 review, 63 abstained. Run before this
  batch; any acceptance is a release blocker and none occurred. (The first
  harness run, against rule /1, FAILED with ~30+ qualifier acceptances — that
  failure forced the token-equality tightening now in rule /3.)
- **Positive sample: PENDING HUMAN REVIEW.** `positive-sample.md` in this
  directory holds 200 accepted links stratified by score band × country
  (seed 42). The §4 bar is ≥98% correct on manual review; 5+ wrong rows means
  thresholds tighten, wrong pairs become tombstones, and the run re-executes.
  P1 must not claim dedupe over these links before this review passes.
- **Propagation = 0 is expected here**: this is the local stack, whose 557
  canonical_wines rows carry no lwin7 (production holds the resolved spine).
  The production run, after 0145 is applied there per
  docs/runbooks/production-migrations.md, is what will populate
  canonical_wines.xwines_wine_id from accepted links.
