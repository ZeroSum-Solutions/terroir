#!/usr/bin/env node
/**
 * Prove the production-shaped fixture reaches NOTHING in `xwines_catalog`.
 *
 * Production's corpus is empty (0 rows); this checkout's holds 100,646, and
 * `xwines_catalog` has no tenant column — one table, one state, and the local
 * corpus must not be deleted because other suites read it. So the fixture
 * reproduces production's rendered outcome the only honest way left: its
 * identities are invented so that every corpus lookup a page makes for one of
 * its wines takes the MISS path, which is byte-for-byte what an empty
 * catalogue returns.
 *
 * That is a claim about data, so it is checked rather than asserted, against
 * the two acceptance rules that actually decide whether a wine gets a corpus
 * picture or a corpus taste profile:
 *
 *   A. IMAGE_ACCEPT (wine-corpus-profile.ts) needs a leading-word prefix of
 *      `name` to match a corpus winery EXACTLY. That is the query
 *      `recoverProducerFromName` makes, so this makes the same one, for every
 *      prefix of every one of the fixture's names.
 *
 *   B. PROFILE_ACCEPT (xwines-profile.ts) needs producer similarity >= 0.80.
 *      `match_xwines` is asked for each distinct producer and every row it
 *      returns must sit under that floor. p_limit is raised well past the
 *      app's 5 because the RPC orders by BLENDED score: a row could in
 *      principle clear the producer floor and still be crowded out of a short
 *      list by better cuvée matches, and a check that could miss the row it is
 *      looking for is not a check.
 *
 * Run standalone (`node scripts/local/prodshape-corpus-miss-check.mjs`) to
 * re-verify, or let `seed-prodshape-tenant.mjs` run it as its pre-write gate.
 */

import { createClient } from "@supabase/supabase-js";
import { WINE_COUNT, wineIdentity } from "./prodshape-identities.mjs";

/** Matches PRODUCER_PREFIX_MAX_WORDS in src/lib/wine-intelligence/producer-from-name.ts. */
const PREFIX_MAX_WORDS = 6;
/** xwines-profile.ts's producer floor. Anything under it cannot be accepted. */
const PRODUCER_FLOOR = 0.8;
/** The base seeder's owner — the only identity this gate needs. */
const SEED_OWNER_EMAIL = "owner+local@terroir.test";

function prefixesOf(name) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const limit = Math.min(PREFIX_MAX_WORDS, words.length - 1);
  const out = [];
  for (let k = limit; k >= 1; k -= 1) out.push(words.slice(0, k).join(" "));
  return out;
}

async function exactWineryPrefixHits(supabase, prefixes) {
  const all = [...prefixes];
  const hits = [];
  for (let i = 0; i < all.length; i += 50) {
    const { data, error } = await supabase
      .from("xwines_catalog")
      .select("winery_name")
      .in("winery_name", all.slice(i, i + 50));
    if (error) throw new Error(`xwines_catalog prefix probe failed: ${error.message}`);
    for (const row of data ?? []) hits.push(row.winery_name);
  }
  return [...new Set(hits)];
}

/**
 * A client whose JWT role is `authenticated`.
 *
 * `match_xwines` is `security definer` with `revoke all from public` and a
 * single `grant execute ... to authenticated` (migration 0134), so a
 * service-role key cannot call it — "permission denied for function". That is
 * correct: the app calls this RPC as a signed-in user, and so must a check
 * that claims to reproduce what the app sees. Signing in as the base seeder's
 * owner is therefore not a workaround, it is the same path the page takes.
 */
export async function authenticatedClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !anonKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY (or " +
        "..._PUBLISHABLE_KEY) must be exported to run the corpus-miss gate.",
    );
  }
  const client = createClient(url, anonKey, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({
    email: SEED_OWNER_EMAIL,
    password: process.env.LOCAL_SEED_USER_PASSWORD ?? "Terroir-local-123!",
  });
  if (error) {
    throw new Error(
      `could not sign in as ${SEED_OWNER_EMAIL} to call match_xwines: ${error.message}. ` +
        "Run `pnpm supabase:seed:local:apply` first.",
    );
  }
  return client;
}

async function producerFloorHits(supabase, producers) {
  const hits = [];
  for (const [producer, cuvee] of producers) {
    const { data, error } = await supabase.rpc("match_xwines", {
      p_producer: producer,
      p_name: cuvee,
      p_threshold: 0.3,
      p_limit: 50,
    });
    if (error) throw new Error(`match_xwines probe failed: ${error.message}`);
    for (const row of data ?? []) {
      if (row.producer_score >= PRODUCER_FLOOR) {
        hits.push(`${producer} -> ${row.winery_name} (${row.producer_score.toFixed(3)})`);
      }
    }
  }
  return hits;
}

/**
 * Throws unless every one of the fixture's wines misses the corpus.
 *
 * `identity(i)` is the seeder's own generator, so this checks the rows that
 * will actually be written rather than a restatement of them.
 */
export async function assertCorpusMiss(supabase, { wineCount, identity }) {
  // Prefix recovery only ever sees a BLANK-producer name: resolveWineCorpusProfile
  // returns before it for any row that has a producer of its own. So those are
  // the names checked — and every prefix length is checked, including the
  // one-word prefixes the app's own IMAGE_ACCEPT floor would reject anyway.
  // A fixture that stays a miss only because a downstream floor caught it is
  // one floor change away from silently growing pictures production cannot have.
  const prefixes = new Set();
  const producers = new Map();
  for (let i = 1; i <= wineCount; i += 1) {
    const { producer, name, blank } = identity(i);
    if (blank) for (const prefix of prefixesOf(name)) prefixes.add(prefix);
    else if (!producers.has(producer)) producers.set(producer, name);
  }

  const exact = await exactWineryPrefixHits(supabase, prefixes);
  if (exact.length > 0) {
    throw new Error(
      `Corpus-miss gate FAILED (A): ${exact.length} fixture name prefix(es) are ` +
        `real X-Wines wineries, so those wines would get a corpus picture that ` +
        `production could not have: ${exact.slice(0, 10).join(", ")}`,
    );
  }

  const fuzzy = await producerFloorHits(
    await authenticatedClient(),
    [...producers.entries()],
  );
  if (fuzzy.length > 0) {
    throw new Error(
      `Corpus-miss gate FAILED (B): ${fuzzy.length} fixture producer(s) clear the ` +
        `${PRODUCER_FLOOR} producer floor: ${fuzzy.slice(0, 10).join(", ")}`,
    );
  }

  console.log(
    `Corpus-miss gate passed: ${prefixes.size} name prefixes match no X-Wines ` +
      `winery exactly, and ${producers.size} producers all score under ` +
      `${PRODUCER_FLOOR} against the corpus.`,
  );
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be exported " +
        "(never from .env.local — it holds production credentials).",
    );
  }
  await assertCorpusMiss(createClient(url, key, { auth: { persistSession: false } }), {
    wineCount: WINE_COUNT,
    identity: wineIdentity,
  });
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message ?? error);
    process.exit(1);
  });
}
