#!/usr/bin/env node
/**
 * Seed a SECOND local tenant shaped like PRODUCTION, not like the demo.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────
 *
 * `scripts/seed-local-supabase.mjs` builds `LOCAL SEED - Osteria Scala`, and
 * that tenant is the best case on every axis a wine renders on: 250 wines,
 * 250 hero photographs, 0 blank producers, 250 spine links. Production is the
 * worst case on all four — 1,385 wines, ONE photograph, 321 blank producers,
 * 1,064 spine links — so a QA pass that only drives the demo tenant is blind
 * to the defects that only appear when the data is thin. A whole work session
 * went green against the demo while "no wine images anywhere in production"
 * sat unnoticed.
 *
 * This fixture is that missing case, at a size a human can drive: 400 wines
 * holding production's RATIOS.
 *
 *   axis                  production        this fixture     ratio
 *   wines                 1,385             400
 *   with hero_image_url   1 (0.07%)         1 (0.25%)        matched
 *   blank producer        321 (23.2%)       93 (23.2%)       matched
 *   spine-linked          1,064 (76.8%)     307 (76.8%)      matched
 *
 * ── THE CORPUS, AND WHAT THIS CANNOT REPRODUCE ─────────────────────────────
 *
 * Production's `xwines_catalog` has 0 rows; this checkout's has 100,646. That
 * is ONE shared table with no tenant column, so both states cannot exist at
 * once and the local corpus must not be deleted — other suites depend on it.
 *
 * So the empty-corpus case is exercised the only honest way available: every
 * producer and cuvée below is INVENTED and verified to match nothing in the
 * corpus, so every corpus lookup a page makes for these wines takes the MISS
 * path and returns exactly what an empty catalogue would return. The negative
 * set is the one `src/lib/wine-intelligence/producer-from-name.ts` and
 * `wine-corpus-profile.ts` already measured against (the base seeder's
 * invented producers), extended in the same register and re-verified — see
 * `scripts/local/prodshape-corpus-miss-check.mjs`, which is a gate this
 * script runs before it writes.
 *
 * What that does NOT reproduce is any read of the corpus that is not scoped to
 * one of these wines. `docs/runbooks/prodshape-tenant.md` §"What this cannot
 * reproduce" lists them.
 *
 * ── SAFETY ─────────────────────────────────────────────────────────────────
 *
 * Same guards as the base seeder, deliberately: dry run unless `--confirm`,
 * `scripts/local/assert-local-db.sh` (THIS repo's loopback stack, not merely
 * "some" local port), and the shared API-readiness wait. AGENTS.md
 * non-negotiable #1 — `.env.local` holds production credentials — is why.
 *
 * ── THE DEFAULT MEMBERSHIP MUST NOT MOVE ───────────────────────────────────
 *
 * `src/lib/api/resolve-active-membership.ts` picks the signed
 * `active_restaurant_id` cookie first and otherwise the MOST RECENTLY CREATED
 * membership. Every e2e spec assumes the dev-login owner lands in the demo
 * tenant, and a dozen of them resolve the restaurant with their own
 * `created_at DESC limit 1` query. So this fixture's memberships are written
 * with a FIXED, DELIBERATELY OLD `created_at` (2026-01-05), and the script
 * asserts afterwards that the owner's newest membership is still the demo
 * tenant's — refusing to report success if it is not.
 *
 * Usage:
 *   node scripts/local/seed-prodshape-tenant.mjs              # dry run
 *   node scripts/local/seed-prodshape-tenant.mjs --confirm    # write
 *   node scripts/local/seed-prodshape-tenant.mjs --teardown --confirm
 */

import { createClient } from "@supabase/supabase-js";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { assertCorpusMiss } from "./prodshape-corpus-miss-check.mjs";
import {
  APPELLATIONS,
  WINE_COUNT,
  wineIdentity,
} from "./prodshape-identities.mjs";

const args = new Set(process.argv.slice(2));
const CONFIRM = args.has("--confirm");
const TEARDOWN = args.has("--teardown");

// No .env.local, ever: it holds production credentials (AGENTS.md #1). The
// caller supplies the local stack in the process environment, exactly as
// scripts/local/dev-local.sh and scratchpad/e2e-run.sh do.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

/** The demo tenant. Its default-ness is what this script must not disturb. */
const DEMO_RESTAURANT_ID =
  process.env.LOCAL_SEED_RESTAURANT_ID ?? "de100000-0000-4000-8000-000000000001";

const RESTAURANT_ID = "de200000-0000-4000-8000-000000000001";
const RESTAURANT_NAME = "LOCAL PRODSHAPE - Trattoria Bianca";

/** Older than any `LOCAL SEED` membership, which the base seeder writes at now(). */
const MEMBERSHIP_CREATED_AT = "2026-01-05T00:00:00.000Z";

const UUID_PREFIX = {
  wine: "de200001",
  inventory: "de200002",
  openBottle: "de200003",
  scan: "de200004",
  list: "de200005",
  section: "de200006",
  item: "de200007",
  pour: "de200009",
  cellarConfig: "de20000a",
  bin: "de20000d",
};

const USERS = [
  { role: "owner", email: "owner+local@terroir.test" },
  { role: "manager", email: "manager+local@terroir.test" },
  { role: "staff", email: "staff+local@terroir.test" },
];

/** The one wine that owns a photograph, mirroring production's single row. */
const HERO_WINE_INDEX = 137;
const HERO_IMAGE_PATH = `${RESTAURANT_ID}/prodshape-hero-${HERO_WINE_INDEX}.jpg`;
/** A real bottle label, present once seed-catalog-imagery.mjs has run. */
const HERO_SOURCE_OBJECT = "xwines/100088.jpeg";
/** Always in the repo, so the fixture never depends on the corpus imagery. */
const HERO_FALLBACK_FIXTURE = "OIP-863239403.jpg";

const LIST_SECTIONS = ["Sparkling & White", "Red - Old World", "Red - New World"];

function uuid(prefix, index) {
  return `${prefix}-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function dayOffset(daysAgo) {
  const d = new Date(Date.UTC(2026, 5, 30, 12, 0, 0));
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString();
}

function dateOffset(daysAgo) {
  return dayOffset(daysAgo).slice(0, 10);
}

function cents(amount) {
  return Number(amount.toFixed(2));
}


function isLocalUrl(rawUrl) {
  try {
    const { hostname } = new URL(rawUrl);
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}

function assertWriteAllowed() {
  if (!CONFIRM) return;
  if (!SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required for --confirm.");
  }
  if (!isLocalUrl(SUPABASE_URL)) {
    throw new Error(`Refusing to seed a non-local Supabase URL: ${SUPABASE_URL}`);
  }
  execFileSync("bash", ["scripts/local/assert-local-db.sh"], {
    env: process.env,
    stdio: "inherit",
  });
  execFileSync(
    "bash",
    ["scripts/local/wait-for-api-ready.sh", SUPABASE_URL, SERVICE_ROLE_KEY],
    { env: process.env, stdio: "inherit" },
  );
}

function buildWines(heroUrl) {
  return Array.from({ length: WINE_COUNT }, (_, idx) => {
    const i = idx + 1;
    const { producer, name, blank } = wineIdentity(i);
    const [, region, country, varietal, colour] =
      APPELLATIONS[i % APPELLATIONS.length];
    const size_ml = i % 53 === 0 ? 1500 : i % 37 === 0 ? 375 : 750;
    const vintage = 2005 + (i % 19);
    const cost = 22 + (i % 64) * 3.15 + (size_ml === 1500 ? 90 : 0);

    return {
      id: uuid(UUID_PREFIX.wine, i),
      restaurant_id: RESTAURANT_ID,
      producer,
      name,
      vintage,
      // A blank-producer row is what a bare CSV import leaves: a name, a
      // vintage, a quantity and a cost, and nothing else. Populating its
      // varietal/region/colour would hide the empty-metadata surfaces this
      // fixture exists to expose.
      varietal: blank ? null : varietal,
      region: blank ? null : region,
      country: blank ? null : country,
      colour: blank ? null : colour,
      size_ml,
      lwin_id: null,
      drink_window_start: blank ? null : vintage + 2,
      peak_year: blank ? null : vintage + 6,
      drink_window_end: blank ? null : vintage + 11,
      serving_temp_min: null,
      serving_temp_max: null,
      serving_temp_label: null,
      decant_minutes: null,
      rating: null,
      rating_source: null,
      review_excerpt: null,
      tasting_notes: null,
      hero_image_url: i === HERO_WINE_INDEX ? heroUrl : null,
      retail_min: null,
      retail_median: null,
      retail_max: null,
      retail_retailer_count: null,
      retail_refreshed_at: null,
      pricing_target_markup_ratio: null,
      pricing_target_pour_cost_pct: null,
      overpaid_flag: false,
      enrichment_metadata: {},
      manual_overrides: [],
      is_eightysixed: i % 61 === 0,
      eightysixed_at: i % 61 === 0 ? dayOffset(i % 14) : null,
      last_enriched_at: null,
      created_at: dayOffset(150 - (i % 140)),
      updated_at: dayOffset(i % 20),
      __cost: cents(cost),
    };
  });
}

function buildRows(heroUrl, userIds) {
  const wines = buildWines(heroUrl);

  const restaurant = {
    id: RESTAURANT_ID,
    name: RESTAURANT_NAME,
    logo_url: null,
    auto_eightysix_from_inventory: true,
    eightysix_ml_threshold: 180,
    eightysix_strategy: "mark",
    default_target_markup_ratio: 3.2,
    default_target_pour_cost_pct: 24.0,
    created_at: dayOffset(300),
    updated_at: dayOffset(0),
  };

  const cellarConfig = [
    {
      id: uuid(UUID_PREFIX.cellarConfig, 1),
      restaurant_id: RESTAURANT_ID,
      name: "Back Cellar",
      rows: 10,
      columns: 14,
      labels: { sections: LIST_SECTIONS, order: LIST_SECTIONS },
      low_stock_threshold: 2,
      reconcile_variance_threshold_oz: 2,
      created_at: dayOffset(300),
      updated_at: dayOffset(2),
    },
  ];

  // Bins: the 10x14 grid the config declares, as real `bins` rows so /bins
  // has zones and capacities rather than only free-text bin_location strings.
  const bins = [];
  for (let row = 0; row < 10; row += 1) {
    for (let col = 1; col <= 14; col += 1) {
      const index = row * 14 + col;
      bins.push({
        id: uuid(UUID_PREFIX.bin, index),
        restaurant_id: RESTAURANT_ID,
        code: `${String.fromCharCode(65 + row)}${col}`,
        zone: LIST_SECTIONS[row % LIST_SECTIONS.length],
        capacity: 12,
        priority: row % 4,
        sort_order: index,
        retired_at: null,
        created_at: dayOffset(300),
        updated_at: dayOffset(3),
      });
    }
  }

  const scans = Array.from({ length: 14 }, (_, idx) => {
    const i = idx + 1;
    const lineItems = Array.from({ length: 5 }, (_, j) => {
      const wine = wines[(idx * 5 + j) % wines.length];
      return {
        producer: wine.producer,
        name: wine.name,
        vintage: wine.vintage,
        qty: 1 + ((i + j) % 5),
        unitCost: wine.__cost,
        currency: "USD",
        format: wine.size_ml === 1500 ? "magnum" : wine.size_ml === 375 ? "half" : "750ml",
        confidence: 0.79 + ((i + j) % 18) / 100,
      };
    });
    return {
      id: uuid(UUID_PREFIX.scan, i),
      restaurant_id: RESTAURANT_ID,
      distributor_name: `Prodshape Distributor ${1 + (i % 4)}`,
      invoice_number: `PRODSHAPE-${String(i).padStart(4, "0")}`,
      invoice_date: dateOffset(i * 5 + 2),
      raw_image_path: `${RESTAURANT_ID}/prodshape/invoice-${i}.jpg`,
      extra_image_paths: [],
      parsed_line_items: lineItems,
      final_line_items: lineItems,
      edits: {},
      accuracy_score: cents(0.8 + (i % 15) / 100),
      item_count: lineItems.length,
      status: i % 7 === 0 ? "needs_review" : "committed",
      ocr_text: { engine: "prodshape_seed", pages: 1, text: "Synthetic invoice text." },
      created_by: userIds.manager ?? null,
      created_at: dayOffset(i * 5),
    };
  });

  // 520 inventory rows over 400 wines: production's cellar holds more bottles
  // than SKUs, and the /cellar and /bins pages both need that to be true.
  const inventoryItems = Array.from({ length: 520 }, (_, idx) => {
    const i = idx + 1;
    const wine = wines[idx % wines.length];
    const bin = bins[(i * 3) % bins.length];
    return {
      id: uuid(UUID_PREFIX.inventory, i),
      wine_id: wine.id,
      restaurant_id: RESTAURANT_ID,
      invoice_scan_id: i <= 70 ? scans[idx % scans.length].id : null,
      quantity: i % 29 === 0 ? 0 : 1 + (i % 7),
      unit_cost: wine.__cost,
      bin_location: bin.code,
      bin_id: bin.id,
      section: bin.zone,
      format: wine.size_ml === 1500 ? "magnum" : wine.size_ml === 375 ? "half" : "750ml",
      currency: "USD",
      added_via: i <= 70 ? "invoice_scan" : "manual",
      added_at: dayOffset(i % 120),
      updated_at: dayOffset(i % 15),
    };
  });

  const lists = [
    {
      id: uuid(UUID_PREFIX.list, 1),
      name: "House List",
      description: "Published list for the production-shaped tenant.",
      slug: "local-prodshape-house",
      is_published: true,
      archived: false,
      template: "classic",
      last_published_at: dayOffset(3),
    },
    {
      id: uuid(UUID_PREFIX.list, 2),
      name: "Draft Additions",
      description: "Unpublished draft used for editor states.",
      slug: null,
      is_published: false,
      archived: false,
      template: "classic",
      last_published_at: null,
    },
  ].map((list, idx) => ({
    ...list,
    restaurant_id: RESTAURANT_ID,
    created_at: dayOffset(200 - idx),
    updated_at: dayOffset(idx),
  }));

  const wineListSections = lists.flatMap((list, listIdx) =>
    LIST_SECTIONS.map((name, idx) => ({
      id: uuid(UUID_PREFIX.section, listIdx * 10 + idx + 1),
      wine_list_id: list.id,
      name,
      position: idx,
      created_at: dayOffset(60 - idx),
    })),
  );

  const listItems = [];
  let itemIndex = 1;
  for (const section of wineListSections) {
    const list = lists.find((l) => l.id === section.wine_list_id);
    const targetCount = list?.is_published ? 18 : 4;
    for (let n = 0; n < targetCount; n += 1) {
      // Deliberately includes blank-producer wines: a public list rendering a
      // row whose producer is '' is one of the surfaces this fixture exists
      // to put in front of a QA pass.
      const wine = wines[(itemIndex * 7 + n) % wines.length];
      listItems.push({
        id: uuid(UUID_PREFIX.item, itemIndex),
        restaurant_id: RESTAURANT_ID,
        section_id: section.id,
        wine_id: wine.id,
        position: n,
        glass_price: itemIndex % 4 === 0 ? cents(13 + (itemIndex % 11)) : null,
        bottle_price: cents(52 + (itemIndex % 80) * 3),
        glass_pour_ml: itemIndex % 4 === 0 ? 150 : null,
        pour_size_mode: "fixed",
        tasting_note: null,
        name_override: null,
        blurb: null,
        hidden: false,
        is_available: !wine.is_eightysixed,
        created_at: dayOffset(itemIndex % 90),
        updated_at: dayOffset(itemIndex % 18),
      });
      itemIndex += 1;
    }
  }

  const openBottles = Array.from({ length: 8 }, (_, idx) => {
    const i = idx + 1;
    const wine = wines[idx * 9];
    return {
      id: uuid(UUID_PREFIX.openBottle, i),
      wine_id: wine.id,
      restaurant_id: RESTAURANT_ID,
      // Clamped: a partial bottle cannot hold more than the bottle does —
      // open_bottles carries a CHECK against the wine's own size_ml, and the
      // fixture's 375ml halves are well under the unclamped spread.
      remaining_ml: Math.min(wine.size_ml - 50, 150 + ((i * 53) % 500)),
      opened_at: dayOffset(i % 9),
      opened_by: userIds.staff ?? userIds.owner ?? null,
      source_inventory_item_id: inventoryItems[idx * 9]?.id ?? null,
      closed_at: null,
    };
  });

  const pourEvents = Array.from({ length: 60 }, (_, idx) => {
    const i = idx + 1;
    const wine = wines[idx % 40];
    const kind = i % 13 === 0 ? "new_bottle" : i % 17 === 0 ? "spill" : "pour";
    return {
      id: uuid(UUID_PREFIX.pour, i),
      wine_id: wine.id,
      restaurant_id: RESTAURANT_ID,
      ml_delta: kind === "new_bottle" ? -wine.size_ml : kind === "spill" ? 60 : 150,
      kind,
      actor_user_id: i % 5 === 0 ? userIds.manager ?? null : userIds.staff ?? null,
      occurred_at: dayOffset(i % 60),
      note: null,
      open_bottle_id: null,
    };
  });

  return {
    restaurant,
    cellarConfig,
    bins,
    wines: wines.map(({ __cost: _cost, ...wine }) => wine),
    scans,
    inventoryItems,
    lists,
    wineListSections,
    listItems,
    openBottles,
    pourEvents,
  };
}

function summarize(rows) {
  const blank = rows.wines.filter((w) => w.producer === "").length;
  return {
    restaurants: 1,
    memberships: USERS.length,
    wines: rows.wines.length,
    "wines: blank producer": blank,
    "wines: hero_image_url": rows.wines.filter((w) => w.hero_image_url).length,
    "wines: expect spine link": rows.wines.length - blank,
    bins: rows.bins.length,
    invoice_scans: rows.scans.length,
    inventory_items: rows.inventoryItems.length,
    wine_lists: rows.lists.length,
    wine_list_sections: rows.wineListSections.length,
    wine_list_items: rows.listItems.length,
    open_bottles: rows.openBottles.length,
    pour_events: rows.pourEvents.length,
  };
}

async function upsertRows(supabase, table, rows, options = {}) {
  for (let i = 0; i < rows.length; i += 100) {
    const { error } = await supabase
      .from(table)
      .upsert(rows.slice(i, i + 100), { onConflict: options.onConflict ?? "id" });
    if (error) throw new Error(`${table} upsert failed: ${error.message}`);
  }
}

async function resolveSeedUserIds(supabase) {
  const { data, error } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  if (error) throw error;
  const byEmail = new Map(
    data.users.filter((u) => u.email).map((u) => [u.email.toLowerCase(), u]),
  );
  const ids = {};
  for (const user of USERS) {
    const found = byEmail.get(user.email.toLowerCase());
    if (!found) {
      throw new Error(
        `Seed user ${user.email} does not exist. Run \`pnpm supabase:seed:local:apply\` ` +
          "first — this fixture attaches to the base seeder's users rather than " +
          "creating its own, because handle_new_user() auto-provisions a restaurant " +
          "for every new auth user and that stray tenant is what makes " +
          "'most recent membership' lookups non-deterministic.",
      );
    }
    ids[user.role] = found.id;
  }
  return ids;
}

/** Bytes for the fixture's single hero photograph. */
async function heroImageBytes(supabase) {
  const { data } = await supabase.storage
    .from("wine-images")
    .download(HERO_SOURCE_OBJECT);
  if (data) return Buffer.from(await data.arrayBuffer());
  // The corpus imagery is seeded by a separate script and may not be present.
  return readFile(new URL(`../../test-invoices/${HERO_FALLBACK_FIXTURE}`, import.meta.url));
}

async function seedImages(supabase, scans) {
  const invoice = await readFile(
    new URL(`../../test-invoices/${HERO_FALLBACK_FIXTURE}`, import.meta.url),
  );
  for (const scan of scans) {
    const { error } = await supabase.storage
      .from("invoice-images")
      .upload(scan.raw_image_path, invoice, {
        contentType: "image/jpeg",
        upsert: true,
      });
    if (error) throw new Error(`invoice image upload failed: ${error.message}`);
  }
}

/**
 * The guard that keeps the whole e2e suite green: after writing, the dev-login
 * owner's NEWEST membership must still be the demo tenant's.
 */
async function assertDemoTenantStillDefault(supabase, ownerId) {
  const { data, error } = await supabase
    .from("memberships")
    .select("restaurant_id, created_at")
    .eq("user_id", ownerId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1);
  if (error) throw error;
  const newest = data?.[0]?.restaurant_id;
  if (newest !== DEMO_RESTAURANT_ID) {
    throw new Error(
      `Default membership moved: the owner's newest membership is ${newest}, ` +
        `expected the demo tenant ${DEMO_RESTAURANT_ID}. Every e2e spec assumes ` +
        "the demo tenant. Fix before using this fixture.",
    );
  }
  console.log(`Default membership unchanged: ${DEMO_RESTAURANT_ID} (demo tenant).`);
}

async function seed() {
  assertWriteAllowed();

  if (!CONFIRM) {
    console.log("");
    console.log(`  Target:     ${SUPABASE_URL}`);
    console.log(`  Mode:       DRY RUN`);
    console.log(`  Restaurant: ${RESTAURANT_ID}  ${RESTAURANT_NAME}`);
    console.table(summarize(buildRows("(hero image, uploaded on --confirm)", {})));
    console.log("DRY RUN - no writes. Pass --confirm to execute.");
    return;
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // Gate: prove the fixture's identities reach nothing in the corpus BEFORE
  // writing them, so the empty-corpus claim is checked rather than asserted.
  await assertCorpusMiss(supabase, {
    wineCount: WINE_COUNT,
    identity: wineIdentity,
  });

  const userIds = await resolveSeedUserIds(supabase);

  const { error: heroUploadError } = await supabase.storage
    .from("wine-images")
    .upload(HERO_IMAGE_PATH, await heroImageBytes(supabase), {
      contentType: "image/jpeg",
      upsert: true,
    });
  if (heroUploadError) {
    throw new Error(`hero image upload failed: ${heroUploadError.message}`);
  }
  const heroUrl = supabase.storage.from("wine-images").getPublicUrl(HERO_IMAGE_PATH)
    .data.publicUrl;

  const rows = buildRows(heroUrl, userIds);

  await upsertRows(supabase, "restaurants", [rows.restaurant]);
  await upsertRows(
    supabase,
    "memberships",
    USERS.map((user) => ({
      user_id: userIds[user.role],
      restaurant_id: RESTAURANT_ID,
      role: user.role,
      created_at: MEMBERSHIP_CREATED_AT,
    })),
    { onConflict: "user_id,restaurant_id" },
  );
  await upsertRows(supabase, "cellar_config", rows.cellarConfig);
  await upsertRows(supabase, "bins", rows.bins);
  await upsertRows(supabase, "wines", rows.wines);
  await upsertRows(supabase, "invoice_scans", rows.scans);
  await seedImages(supabase, rows.scans);
  await upsertRows(supabase, "inventory_items", rows.inventoryItems);
  await upsertRows(supabase, "wine_lists", rows.lists);
  await upsertRows(supabase, "wine_list_sections", rows.wineListSections);
  await upsertRows(supabase, "wine_list_items", rows.listItems);
  await upsertRows(supabase, "open_bottles", rows.openBottles, {
    onConflict: "wine_id,restaurant_id",
  });
  await upsertRows(supabase, "pour_events", rows.pourEvents);

  // Same call the base seeder makes and for the same reason: these wines are
  // written straight into the table, so nothing resolves their identity on the
  // way in. It skips rows whose producer normalizes to nothing, which is what
  // leaves the 93 blank rows unlinked — production's shape, not a shortcut.
  const { data: resolved, error: backfillError } = await supabase.rpc(
    "backfill_wine_identity",
    { p_restaurant_id: RESTAURANT_ID },
  );
  if (backfillError) {
    throw new Error(`wine identity backfill failed: ${backfillError.message}`);
  }
  console.log(`Resolved wine identity for ${resolved ?? 0} wine(s).`);

  await assertDemoTenantStillDefault(supabase, userIds.owner);

  console.table(summarize(rows));
  console.log(`Seed complete: ${RESTAURANT_NAME} (${RESTAURANT_ID}).`);
}

/**
 * Delete the spine rows this fixture created, and ONLY the ones nothing else
 * still points at.
 *
 * `canonical_wines` is shared across tenants on purpose: two restaurants
 * holding the same wine resolve to the same canonical row. So "this fixture
 * created it" is not on its own a licence to delete it — another tenant's
 * `wine_variants` row may have bound to it since. The reference check is what
 * makes the cleanup exact rather than merely thorough.
 */
async function removeUnreferencedCanonicalWines(supabase, ids) {
  let removed = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const { data: bound, error: boundError } = await supabase
      .from("wine_variants")
      .select("canonical_wine_id")
      .in("canonical_wine_id", chunk);
    if (boundError) throw boundError;
    const stillBound = new Set((bound ?? []).map((row) => row.canonical_wine_id));
    const deletable = chunk.filter((id) => !stillBound.has(id));
    if (deletable.length === 0) continue;
    const { error } = await supabase.from("canonical_wines").delete().in("id", deletable);
    if (error) throw error;
    removed += deletable.length;
  }
  if (removed > 0) console.log(`Removed ${removed} unreferenced canonical_wines row(s).`);
}

async function teardown() {
  assertWriteAllowed();
  if (!CONFIRM) {
    console.log(`DRY RUN - would delete ${RESTAURANT_ID} (${RESTAURANT_NAME}).`);
    return;
  }
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const rows = buildRows(null, {});
  const { error: invoiceError } = await supabase.storage
    .from("invoice-images")
    .remove(rows.scans.map((scan) => scan.raw_image_path));
  if (invoiceError) throw invoiceError;
  const { error: heroError } = await supabase.storage
    .from("wine-images")
    .remove([HERO_IMAGE_PATH]);
  if (heroError) throw heroError;

  // The identity spine is GLOBAL — `canonical_wines` has no restaurant_id, and
  // its `created_by_restaurant_id` is ON DELETE SET NULL. So deleting the
  // restaurant strands every canonical row this fixture created: unreachable,
  // unattributed, and one more of them after every seed/teardown cycle. They
  // have to be collected BEFORE the delete, while the attribution still exists.
  const { data: canonical, error: canonicalError } = await supabase
    .from("canonical_wines")
    .select("id")
    .eq("created_by_restaurant_id", RESTAURANT_ID);
  if (canonicalError) throw canonicalError;
  const canonicalIds = (canonical ?? []).map((row) => row.id);

  // Everything tenant-scoped hangs off `restaurants` by ON DELETE CASCADE.
  const { error } = await supabase.from("restaurants").delete().eq("id", RESTAURANT_ID);
  if (error) throw error;

  await removeUnreferencedCanonicalWines(supabase, canonicalIds);

  console.log(`Teardown complete: ${RESTAURANT_ID} removed.`);
}

if (!SUPABASE_URL) {
  console.error(
    "Refusing to run: NEXT_PUBLIC_SUPABASE_URL is not set. This script never " +
      "reads .env.local (it holds production credentials). Run it through " +
      "`scripts/local/prodshape.sh`, which pins the local stack from " +
      "`supabase status`.",
  );
  process.exit(1);
}

const run = TEARDOWN ? teardown : seed;
run().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
