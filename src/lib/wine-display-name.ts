/**
 * BUG-01 — the producer, shown once.
 *
 * Devin photographed a wine side-panel reading "Benoit Ente Benoit Ente,
 * Puligny-Montrachet" and a bin panel reading "Puy Florent, Puy Florent,
 * Merlot, Pays d'Oc". Nothing in the app concatenates the producer twice.
 * Every surface renders `producer` on one line and `name` on the next, exactly
 * once each — the duplication is in the DATA, and it arrived by a route worth
 * naming because it is still open:
 *
 *   A CSV import wrote 1,277 wines with an EMPTY `producer` and the producer
 *   embedded in `name` ("Benjamin Leroux Vosne-Romanée"). Migration `0137`
 *   then recovered 956 of those producers by longest-word-prefix match against
 *   `lwin_catalog` and wrote them into `producer` — correctly, and WITHOUT
 *   touching `name`, because rewriting a tenant's wine names from a fuzzy
 *   catalogue match is not a thing a migration should do. The row that comes
 *   out the far end is right in the database and doubled on the screen.
 *
 * So the repair belongs at the point of RENDER, not in the data: drop the
 * producer from the front of the name when it is genuinely there, and leave
 * both columns untouched. That also keeps the display correct for rows written
 * before `0137`, rows written after it, and rows a future import writes badly
 * again — none of which a one-shot data repair can promise.
 *
 * WHAT THIS DELIBERATELY WILL NOT DO
 *
 * It will not strip a word that merely STARTS with the producer. This cellar
 * holds `producer = "Oberrotweil"` beside `name = "Oberrotweiler Spätburgunder
 * Spätlese Trocken"` — a different word with the same opening. Comparing whole
 * words rather than characters is what keeps that name intact; a `startsWith`
 * on the raw strings would render it as "er Spätburgunder Spätlese Trocken".
 *
 * It will not empty a name. A wine whose name IS its producer ("Château
 * Margaux" / "Château Margaux") keeps what it has: showing a producer twice is
 * a smaller failure than showing the wine nowhere.
 */

/**
 * One word, reduced to what makes it the same word: ligatures folded, accents
 * dropped, case folded, punctuation removed. An empty result means the "word"
 * was punctuation all along ("&", "-") and carries no identity.
 *
 * Unlike `normalizeProducerOrCuvee` in the identity spine, this does NOT sort
 * tokens. That helper sorts so "Domaine Jean Grivot" and "Jean Grivot Domaine"
 * collide, which is right for an identity key and wrong here — this comparison
 * is positional, and sorting would make a prefix test meaningless. Two
 * different jobs, two different normalizations, on purpose.
 */
function foldWord(word: string): string {
  return word
    .replace(/œ/g, "oe")
    .replace(/æ/g, "ae")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function foldedWords(value: string): string[] {
  return value.split(/\s+/).map(foldWord).filter((w) => w !== "");
}

/**
 * The wine name to render beside a producer that is already on screen.
 *
 * Returns `name` unchanged whenever the producer is absent, is not actually at
 * the front of the name, or is the whole of it.
 */
export function wineDisplayName(
  producer: string | null | undefined,
  name: string | null | undefined,
): string {
  const rawName = name ?? "";
  const producerWords = foldedWords(producer ?? "");
  if (producerWords.length === 0 || rawName.trim() === "") return rawName;

  // Walk the name's words in place, so the index just past the last matched
  // word is an offset into the ORIGINAL string. Folding is not
  // length-preserving — "ö" decomposes, punctuation vanishes — so an offset
  // taken from folded text would not address the source.
  let matched = 0;
  let cut = 0;
  for (const token of rawName.matchAll(/\S+/g)) {
    const folded = foldWord(token[0]);
    // Punctuation between words ("&", "—") belongs to neither name; step over
    // it rather than failing the comparison on it.
    if (folded === "") continue;
    if (folded !== producerWords[matched]) break;
    matched += 1;
    cut = token.index + token[0].length;
    if (matched === producerWords.length) break;
  }
  if (matched !== producerWords.length) return rawName;

  const remainder = rawName.slice(cut).replace(/^[\s,;:.–—-]+/, "").trim();
  return remainder === "" ? rawName : remainder;
}
