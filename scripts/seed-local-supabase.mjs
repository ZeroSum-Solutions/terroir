#!/usr/bin/env node
/**
 * Seed sanitized, production-scale-ish local data for Terroir.
 *
 * Defaults to a dry run. Pass --confirm to write. The write path refuses
 * non-local Supabase URLs unless ALLOW_NON_LOCAL_SUPABASE_SEED=yes is set,
 * and it always blocks URLs matching PROD_SUPABASE_URL_PATTERN unless
 * ALLOW_PROD_SEED=yes is also set.
 */

import { createClient } from "@supabase/supabase-js";
import { sectionNameFor } from "./local/wine-sections.mjs";
import { config } from "dotenv";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

config({ path: ".env.local" });

const args = new Set(process.argv.slice(2));
const CONFIRM = args.has("--confirm");
const TEARDOWN = args.has("--teardown");

// No hardcoded fallback: this repo's local stack and other local Supabase
// stacks on this machine use different ports, and a fallback here risked
// silently seeding/mutating a DIFFERENT project's database.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
if (!SUPABASE_URL) {
  console.error(
    "Refusing to run: NEXT_PUBLIC_SUPABASE_URL is not set (checked env + .env.local).",
  );
  process.exit(1);
}
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const PROD_URL_PATTERN = process.env.PROD_SUPABASE_URL_PATTERN ?? "";
const ALLOW_NON_LOCAL =
  process.env.ALLOW_NON_LOCAL_SUPABASE_SEED === "yes";
const ALLOW_PROD = process.env.ALLOW_PROD_SEED === "yes";

const PASSWORD = process.env.LOCAL_SEED_USER_PASSWORD ?? "Terroir-local-123!";
const RESTAURANT_ID =
  process.env.LOCAL_SEED_RESTAURANT_ID ??
  "de100000-0000-4000-8000-000000000001";

const USERS = [
  { role: "owner", email: "owner+local@terroir.test" },
  { role: "manager", email: "manager+local@terroir.test" },
  { role: "staff", email: "staff+local@terroir.test" },
];

const UUID_PREFIX = {
  wine: "de100001",
  inventory: "de100002",
  openBottle: "de100003",
  scan: "de100004",
  list: "de100005",
  section: "de100006",
  item: "de100007",
  availability: "de100008",
  pour: "de100009",
  cellarConfig: "de10000a",
  invite: "de10000b",
  dryUser: "de10000c",
};

const DRY_USER_IDS = {
  owner: uuid(UUID_PREFIX.dryUser, 1),
  manager: uuid(UUID_PREFIX.dryUser, 2),
  staff: uuid(UUID_PREFIX.dryUser, 3),
};

const regions = [
  ["Burgundy", "France", "Pinot Noir", "red"],
  ["Bordeaux", "France", "Cabernet Blend", "red"],
  ["Champagne", "France", "Chardonnay", "sparkling"],
  ["Loire", "France", "Sauvignon Blanc", "white"],
  ["Piedmont", "Italy", "Nebbiolo", "red"],
  ["Tuscany", "Italy", "Sangiovese", "red"],
  ["Rioja", "Spain", "Tempranillo", "red"],
  ["Mosel", "Germany", "Riesling", "white"],
  ["Willamette Valley", "United States", "Pinot Noir", "red"],
  ["Napa Valley", "United States", "Cabernet Sauvignon", "red"],
  ["Sonoma Coast", "United States", "Chardonnay", "white"],
  ["Mendoza", "Argentina", "Malbec", "red"],
  ["Barossa Valley", "Australia", "Shiraz", "red"],
  ["Marlborough", "New Zealand", "Sauvignon Blanc", "white"],
  ["Santorini", "Greece", "Assyrtiko", "white"],
  ["Douro", "Portugal", "Touriga Nacional", "fortified"],
  ["Provence", "France", "Grenache", "rose"],
  ["Tokaj", "Hungary", "Furmint", "dessert"],
];

const producers = [
  "Aster House",
  "Beacon Ridge",
  "Canto Verde",
  "Domaine du Marchand",
  "Eastfold Cellars",
  "Fable & Stone",
  "Granite Coast",
  "Hollow Hill",
  "Iris Bench",
  "Juniper Vale",
  "Kingfisher Estate",
  "Linden & Row",
  "Maison Orme",
  "Northline",
  "Oro Vista",
  "Pillar & Thread",
  "Quartz Run",
  "Riverglass",
  "Sable Crown",
  "Trellis Road",
];

const sections = [
  "Sparkling",
  "Whites",
  "Rose",
  "Reds - Old World",
  "Reds - New World",
  "Dessert & Fortified",
];

const invoiceImageFixtures = [
  "OIP-2427424005.jpg",
  "OIP-3239974709.jpg",
  "OIP-863239403.jpg",
  "OIP-1231690657.jpg",
  "OIP-2622458412.jpg",
  "OIP-1998228646.jpg",
  "OIP-1658565059.jpg",
];

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

  if (PROD_URL_PATTERN && SUPABASE_URL.includes(PROD_URL_PATTERN) && !ALLOW_PROD) {
    throw new Error(
      `Refusing to seed: target URL matches PROD_SUPABASE_URL_PATTERN (${PROD_URL_PATTERN}).`,
    );
  }

  if (!isLocalUrl(SUPABASE_URL) && !ALLOW_NON_LOCAL) {
    throw new Error(
      "Refusing to seed a non-local Supabase URL. Set ALLOW_NON_LOCAL_SUPABASE_SEED=yes only for approved staging.",
    );
  }

  // Hard gate: must match THIS repo's local stack exactly (not just "some"
  // local port) — other projects' local Supabase stacks on this machine
  // run on their own ports and must never be reachable from here.
  execFileSync("bash", ["scripts/local/assert-local-db.sh"], {
    env: process.env,
    stdio: "inherit",
  });

  // Readiness gate, shared with scripts/local/dev-stack.sh (the canonical
  // bring-up entry point) via scripts/local/wait-for-api-ready.sh rather
  // than a second, hand-rolled node implementation that could drift from
  // it. `dev-stack.sh` only seeds after `supabase db reset` because that
  // reset restarts the auth (GoTrue) container and Kong can keep routing
  // to its stale Docker IP for a few seconds, returning transient 502s —
  // see docs/runbooks/local-stack.md "Post-reset readiness". This script
  // is also a supported, directly-invokable entry point (someone can run
  // `supabase db reset` themselves and then call this seeder straight
  // away), so it needs the identical protection: without it, a sequential
  // writer like ensureUsers()/upsertRows() can fail partway through a run
  // against a not-yet-ready API instead of refusing cleanly up front.
  execFileSync(
    "bash",
    [
      "scripts/local/wait-for-api-ready.sh",
      SUPABASE_URL,
      SERVICE_ROLE_KEY,
    ],
    { env: process.env, stdio: "inherit" },
  );
}

function buildRows(userIds = DRY_USER_IDS) {
  const now = dayOffset(0);

  const restaurant = {
    id: RESTAURANT_ID,
    name: "LOCAL SEED - Osteria Scala",
    logo_url: null,
    auto_eightysix_from_inventory: true,
    eightysix_ml_threshold: 180,
    eightysix_strategy: "mark",
    default_target_markup_ratio: 3.2,
    // A PERCENTAGE, not a fraction — the column is numeric(5,2) with a
    // CHECK (> 0 AND < 100) and a 22.00 default (0026_pricing_intelligence_
    // metadata.sql). This read 0.24, which made every suggested glass price
    // exactly 100x too large ($7,203 a glass) the moment the list editor
    // started rendering suggestions.
    default_target_pour_cost_pct: 24.0,
    created_at: dayOffset(120),
    updated_at: now,
  };

  const wines = Array.from({ length: 250 }, (_, idx) => {
    const i = idx + 1;
    const [region, country, varietal, colour] = regions[idx % regions.length];
    const producer = producers[idx % producers.length];
    const size_ml = i % 47 === 0 ? 1500 : i % 31 === 0 ? 375 : 750;
    const vintage = 1998 + (i % 27);
    const cost = 18 + (i % 70) * 2.75 + (size_ml === 1500 ? 80 : 0);
    const retailMedian = cost * (1.55 + (i % 9) / 20);

    return {
      id: uuid(UUID_PREFIX.wine, i),
      restaurant_id: RESTAURANT_ID,
      producer,
      name: `${region} ${varietal} Lot ${String(i).padStart(3, "0")}`,
      vintage,
      varietal,
      region,
      country,
      colour,
      size_ml,
      lwin_id: `LOCAL${String(i).padStart(7, "0")}`,
      drink_window_start: vintage + 2,
      peak_year: vintage + 6,
      drink_window_end: vintage + 12,
      serving_temp_min: colour === "red" ? 55 : colour === "sparkling" ? 42 : 46,
      serving_temp_max: colour === "red" ? 62 : colour === "sparkling" ? 48 : 52,
      serving_temp_label: colour === "red" ? "Cellar cool" : "Well chilled",
      decant_minutes: colour === "red" ? (i % 4) * 20 : null,
      rating: i % 5 === 0 ? 88 + (i % 10) : null,
      rating_source: i % 5 === 0 ? "Local Seed Panel" : null,
      review_excerpt:
        i % 5 === 0
          ? "Structured local fixture with enough metadata for enrichment, pricing, and drawer states."
          : null,
      tasting_notes:
        i % 6 === 0
          ? "Sanitized tasting note: citrus, mineral, red fruit, spice, and a clean finish."
          : null,
      hero_image_url: null,
      retail_min: cents(retailMedian * 0.86),
      retail_median: cents(retailMedian),
      retail_max: cents(retailMedian * 1.22),
      retail_retailer_count: 4 + (i % 12),
      retail_refreshed_at: dayOffset(i % 21),
      pricing_target_markup_ratio: i % 12 === 0 ? 3.6 : null,
      pricing_target_pour_cost_pct: i % 17 === 0 ? 0.21 : null,
      overpaid_flag: i % 53 === 0,
      pricing_dismissed_until: i % 61 === 0 ? dayOffset(-14) : null,
      alert_snoozed_until: i % 67 === 0 ? dayOffset(-7) : null,
      enrichment_metadata: {
        source: "local_seed",
        fields_enriched: ["drink_window", "serving_temp", "retail"],
        enriched_at: dayOffset(i % 30),
      },
      manual_overrides: i % 29 === 0 ? ["drink_window"] : [],
      is_eightysixed: i % 37 === 0,
      eightysixed_at: i % 37 === 0 ? dayOffset(i % 10) : null,
      eightysixed_by: i % 37 === 0 ? userIds.manager ?? null : null,
      last_enriched_at: dayOffset(i % 30),
      created_at: dayOffset(120 - (i % 90)),
      updated_at: dayOffset(i % 10),
    };
  });

  const scans = Array.from({ length: 60 }, (_, idx) => {
    const i = idx + 1;
    const lineItems = Array.from({ length: 4 }, (_, j) => {
      const wine = wines[(idx * 4 + j) % wines.length];
      return {
        producer: wine.producer,
        name: wine.name,
        vintage: wine.vintage,
        varietal: wine.varietal,
        region: wine.region,
        qty: 1 + ((i + j) % 6),
        unitCost: cents(20 + ((i + j) % 50) * 3.1),
        currency: "USD",
        format: wine.size_ml === 1500 ? "magnum" : wine.size_ml === 375 ? "half" : "750ml",
        confidence: 0.82 + ((i + j) % 15) / 100,
      };
    });

    return {
      id: uuid(UUID_PREFIX.scan, i),
      restaurant_id: RESTAURANT_ID,
      distributor_name: `Local Distributor ${1 + (i % 8)}`,
      invoice_number: `LOCAL-${String(i).padStart(4, "0")}`,
      invoice_date: dateOffset(i + 3),
      raw_image_path: `${RESTAURANT_ID}/local-seed/invoice-${i}.jpg`,
      extra_image_paths: i % 5 === 0 ? [`${RESTAURANT_ID}/local-seed/invoice-${i}-page-2.jpg`] : [],
      parsed_line_items: lineItems,
      final_line_items: lineItems.map((item, j) => ({
        ...item,
        corrected: (i + j) % 11 === 0,
      })),
      edits: i % 11 === 0 ? { corrected_fields: ["producer", "quantity"] } : {},
      accuracy_score: cents(0.84 + (i % 14) / 100),
      item_count: lineItems.length,
      // The app's own vocabulary (src/app/(app)/scans/scan-list-status.ts):
      // complete | processing | review | failed. "committed"/"needs_review"
      // were seed-only words the scan-history chips could not count.
      status: i % 13 === 0 ? "review" : "complete",
      status_reason: i % 13 === 0 ? "arithmetic_mismatch" : null,
      ocr_text: {
        engine: "local_seed",
        pages: i % 5 === 0 ? 2 : 1,
        text: "Synthetic invoice OCR text for local testing only.",
      },
      created_by: userIds.manager ?? null,
      created_at: dayOffset(i),
    };
  });

  const inventoryItems = Array.from({ length: 400 }, (_, idx) => {
    const i = idx + 1;
    const wine = wines[idx % wines.length];
    const scan = scans[idx % scans.length];
    return {
      id: uuid(UUID_PREFIX.inventory, i),
      wine_id: wine.id,
      restaurant_id: RESTAURANT_ID,
      invoice_scan_id: i <= 240 ? scan.id : null,
      quantity: i % 41 === 0 ? 0 : 1 + (i % 6),
      unit_cost: cents(18 + (i % 80) * 2.9),
      // Bare bin code, inside the 12x16 grid this seed configures, spread
      // across it rather than clustered on one diagonal.
      // It used to read `Row A17`: the Grid view keys its cells by bare code
      // (`A1`), so the "Row " prefix matched nothing and every one of the 192
      // cells rendered empty for a cellar holding 1,364 bottles. The column
      // also ran to 24, past the 16 the config declares. The 5 is coprime
      // with 16 so the columns cycle fully instead of repeating early.
      bin_location: `${String.fromCharCode(65 + (i % 12))}${1 + ((i * 5) % 16)}`,
      // Filed by the wine's own colour and origin (scripts/local/wine-sections.mjs),
      // not dealt round-robin: /cellar groups by this column, and a "Sparkling"
      // section holding a red is the first thing a sommelier sees.
      section: sectionNameFor(wine)[0],
      format: wine.size_ml === 1500 ? "magnum" : wine.size_ml === 375 ? "half" : "750ml",
      currency: "USD",
      added_via: i <= 240 ? "invoice_scan" : "manual",
      added_at: dayOffset(i % 90),
      updated_at: dayOffset(i % 12),
    };
  });

  const lists = [
    {
      id: uuid(UUID_PREFIX.list, 1),
      name: "By the Glass",
      description: "Seeded BTG list with pour tracking enabled.",
      slug: "local-seed-by-the-glass",
      is_published: true,
      archived: false,
      template: "classic",
      last_published_at: dayOffset(1),
    },
    {
      id: uuid(UUID_PREFIX.list, 2),
      name: "Full Bottle List",
      description: "Large public list for guest rendering and print/PDF checks.",
      slug: "local-seed-full-list",
      is_published: true,
      archived: false,
      template: "classic",
      last_published_at: dayOffset(2),
    },
    {
      id: uuid(UUID_PREFIX.list, 3),
      name: "Draft Pairings",
      description: "Unpublished draft used for editor states.",
      slug: null,
      is_published: false,
      archived: false,
      template: "classic",
      last_published_at: null,
    },
    {
      id: uuid(UUID_PREFIX.list, 4),
      name: "Archived Spring List",
      description: "Archived list used for delete/archive states.",
      slug: "local-seed-archived-spring",
      is_published: false,
      archived: true,
      template: "classic",
      last_published_at: dayOffset(80),
    },
  ].map((list, idx) => ({
    ...list,
    restaurant_id: RESTAURANT_ID,
    created_at: dayOffset(90 - idx),
    updated_at: dayOffset(idx),
  }));

  const wineListSections = lists.flatMap((list, listIdx) => {
    if (listIdx === 2) {
      return sections.slice(0, 3).map((name, idx) => ({
        id: uuid(UUID_PREFIX.section, listIdx * 10 + idx + 1),
        wine_list_id: list.id,
        name,
        position: idx,
        created_at: dayOffset(30 - idx),
      }));
    }
    if (listIdx === 3) {
      return sections.slice(0, 4).map((name, idx) => ({
        id: uuid(UUID_PREFIX.section, listIdx * 10 + idx + 1),
        wine_list_id: list.id,
        name,
        position: idx,
        created_at: dayOffset(80 - idx),
      }));
    }
    return sections.map((name, idx) => ({
      id: uuid(UUID_PREFIX.section, listIdx * 10 + idx + 1),
      wine_list_id: list.id,
      name,
      position: idx,
      created_at: dayOffset(30 - idx),
    }));
  });

  const listItems = [];
  let itemIndex = 1;
  for (const section of wineListSections) {
    const list = lists.find((l) => l.id === section.wine_list_id);
    const targetCount =
      list?.name === "By the Glass"
        ? 3
        : list?.name === "Full Bottle List"
          ? 30
          : list?.archived
            ? 6
            : 4;
    for (let n = 0; n < targetCount; n++) {
      const wine = wines[(itemIndex * 7 + n) % wines.length];
      const isByGlass = list?.name === "By the Glass";
      listItems.push({
        id: uuid(UUID_PREFIX.item, itemIndex),
        // 0080 denormalized restaurant_id onto wine_list_items (NOT NULL).
        restaurant_id: RESTAURANT_ID,
        section_id: section.id,
        wine_id: wine.id,
        position: n,
        glass_price: isByGlass ? cents(12 + (itemIndex % 13)) : null,
        bottle_price: cents(48 + (itemIndex % 90) * 3),
        glass_pour_ml: isByGlass ? (itemIndex % 5 === 0 ? 90 : 150) : null,
        pour_size_mode: isByGlass && itemIndex % 4 === 0 ? "picker" : "fixed",
        tasting_note:
          itemIndex % 8 === 0
            ? "Local fixture note for public menu and print rendering."
            : null,
        // Never an invented name: name_override renders VERBATIM on the public
        // guest menu and always wins over the wine's real name (render.ts), so
        // a seeded "<producer> Reserve Pour" put a fake wine in front of guests.
        name_override: null,
        blurb: itemIndex % 11 === 0 ? "Sanitized menu blurb for editor/public state." : null,
        hidden: itemIndex % 43 === 0,
        is_available: !wine.is_eightysixed,
        created_at: dayOffset(itemIndex % 60),
        updated_at: dayOffset(itemIndex % 14),
      });
      itemIndex++;
    }
  }

  const pourEvents = Array.from({ length: 200 }, (_, idx) => {
    const i = idx + 1;
    const wine = wines[idx % 80];
    const kind =
      i % 23 === 0
        ? "spill"
        : i % 19 === 0
          ? "finish_bottle"
          : i % 17 === 0
            ? "reconcile"
            : i % 11 === 0
              ? "new_bottle"
              : "pour";
    const mlDelta =
      kind === "new_bottle"
        ? -wine.size_ml
        : kind === "reconcile"
          ? (i % 2 === 0 ? 45 : -30)
          : kind === "finish_bottle"
            ? 180
            : kind === "spill"
              ? 60
              : i % 5 === 0
                ? 90
                : 150;

    return {
      id: uuid(UUID_PREFIX.pour, i),
      wine_id: wine.id,
      restaurant_id: RESTAURANT_ID,
      ml_delta: mlDelta,
      kind,
      actor_user_id:
        i % 7 === 0 ? userIds.manager ?? null : userIds.staff ?? userIds.owner ?? null,
      occurred_at: dayOffset(i % 90),
      note: i % 13 === 0 ? "Local seed pour note" : null,
      open_bottle_id: null,
    };
  });

  const openBottles = Array.from({ length: 25 }, (_, idx) => {
    const i = idx + 1;
    const wine = wines[idx];
    return {
      id: uuid(UUID_PREFIX.openBottle, i),
      wine_id: wine.id,
      restaurant_id: RESTAURANT_ID,
      remaining_ml: 120 + ((i * 37) % Math.max(240, wine.size_ml - 120)),
      opened_at: dayOffset(i % 12),
      opened_by: userIds.staff ?? userIds.manager ?? null,
      source_inventory_item_id: inventoryItems[idx]?.id ?? null,
      closed_at: null,
    };
  });

  const availabilityEvents = Array.from({ length: 30 }, (_, idx) => {
    const i = idx + 1;
    const wine = wines[(i * 11) % wines.length];
    const direction = i % 6 === 0 ? "reconcile" : i % 2 === 0 ? "restored" : "eightysixed";
    return {
      id: uuid(UUID_PREFIX.availability, i),
      wine_id: wine.id,
      restaurant_id: RESTAURANT_ID,
      direction,
      delta: direction === "reconcile" ? (i % 2 === 0 ? 60 : -45) : null,
      user_id: userIds.manager ?? userIds.owner ?? null,
      note: `Local seed ${direction} event`,
      created_at: dayOffset(i % 45),
    };
  });

  const cellarConfig = [
    {
      id: uuid(UUID_PREFIX.cellarConfig, 1),
      restaurant_id: RESTAURANT_ID,
      name: "Main Cellar",
      rows: 12,
      columns: 16,
      labels: {
        sections,
        order: sections,
        pourDefaults: {
          red: 150,
          white: 150,
          sparkling: 125,
          dessert: 75,
        },
      },
      low_stock_threshold: 3,
      reconcile_variance_threshold_oz: 2,
      created_at: dayOffset(120),
      updated_at: dayOffset(1),
    },
  ];

  const invitations = Array.from({ length: 10 }, (_, idx) => {
    const i = idx + 1;
    return {
      id: uuid(UUID_PREFIX.invite, i),
      restaurant_id: RESTAURANT_ID,
      email: `pending-${i}@terroir.test`,
      role: i % 3 === 0 ? "manager" : "staff",
      invited_by: userIds.owner ?? null,
      token: `local-seed-token-${String(i).padStart(2, "0")}`,
      expires_at: dayOffset(-7 + i),
      accepted_at: i % 5 === 0 ? dayOffset(i) : null,
      created_at: dayOffset(15 - i),
    };
  }).filter((invite) => invite.invited_by);

  return {
    restaurant,
    wines,
    scans,
    inventoryItems,
    lists,
    wineListSections,
    listItems,
    pourEvents,
    openBottles,
    availabilityEvents,
    cellarConfig,
    invitations,
  };
}

function summarize(rows) {
  return {
    restaurants: 1,
    users: USERS.length,
    wines: rows.wines.length,
    invoice_scans: rows.scans.length,
    inventory_items: rows.inventoryItems.length,
    wine_lists: rows.lists.length,
    wine_list_sections: rows.wineListSections.length,
    wine_list_items: rows.listItems.length,
    pour_events: rows.pourEvents.length,
    open_bottles: rows.openBottles.length,
    availability_events: rows.availabilityEvents.length,
    cellar_config: rows.cellarConfig.length,
    invitations: rows.invitations.length,
  };
}

function printPlan(rows) {
  const mode = TEARDOWN ? "TEARDOWN" : CONFIRM ? "LIVE SEED" : "DRY RUN";
  console.log("");
  console.log(`  Target:     ${SUPABASE_URL}`);
  console.log(`  Mode:       ${mode}`);
  console.log(`  Restaurant: ${RESTAURANT_ID}`);
  console.log(`  Local URL:  ${isLocalUrl(SUPABASE_URL) ? "yes" : "no"}`);
  console.log("");
  console.table(summarize(rows));
  console.log("  Users:");
  for (const user of USERS) {
    console.log(`    ${user.role.padEnd(7)} ${user.email}`);
  }
  console.log("");
  if (!CONFIRM) {
    console.log("DRY RUN - no writes. Pass --confirm to execute.");
  }
}

async function listAllUsers(supabase) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page,
      perPage: 1000,
    });
    if (error) throw error;
    out.push(...data.users);
    if (data.users.length < 1000) break;
  }
  return out;
}

async function ensureUsers(supabase) {
  const existing = await listAllUsers(supabase);
  const byEmail = new Map(
    existing
      .filter((user) => user.email)
      .map((user) => [user.email.toLowerCase(), user]),
  );

  const ids = {};
  for (const seedUser of USERS) {
    const found = byEmail.get(seedUser.email.toLowerCase());
    if (found) {
      ids[seedUser.role] = found.id;
      continue;
    }

    const { data, error } = await supabase.auth.admin.createUser({
      email: seedUser.email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: {
        full_name: `Local ${seedUser.role}`,
        restaurant_name: "LOCAL SEED - Osteria Scala",
      },
    });
    if (error) throw error;
    ids[seedUser.role] = data.user.id;

    // handle_new_user() (supabase/migrations/0001_auth_boundary.sql) fires
    // on every auth.users insert and auto-provisions its own restaurant +
    // owner membership. That's correct for real signups, but here it leaves
    // each seed user (manager/staff included) with a second, empty
    // restaurant alongside the deterministic one seeded below — a stray
    // membership that makes "most recent membership" lookups (dev-login,
    // requireMembership, E2E fixtures) non-deterministic. Remove the
    // trigger's restaurant immediately; cascade deletes its membership too.
    await removeAutoProvisionedRestaurant(supabase, data.user.id);
  }
  return ids;
}

async function removeAutoProvisionedRestaurant(supabase, userId) {
  const { data: autoMemberships, error } = await supabase
    .from("memberships")
    .select("restaurant_id")
    .eq("user_id", userId);
  if (error) throw error;
  for (const membership of autoMemberships ?? []) {
    if (membership.restaurant_id === RESTAURANT_ID) continue;
    const { error: deleteError } = await supabase
      .from("restaurants")
      .delete()
      .eq("id", membership.restaurant_id);
    if (deleteError) throw deleteError;
  }
}

async function upsertRows(supabase, table, rows, options = {}) {
  if (rows.length === 0) return;

  const batchSize = options.batchSize ?? 100;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { error } = await supabase.from(table).upsert(batch, {
      onConflict: options.onConflict ?? "id",
    });
    if (error) {
      throw new Error(`${table} upsert failed: ${error.message}`);
    }
  }
}

function seedImagePaths(scans) {
  return scans.flatMap((scan) => [
    scan.raw_image_path,
    ...(scan.extra_image_paths ?? []),
  ]);
}

async function seedInvoiceImages(supabase, scans) {
  const fixtures = await Promise.all(
    invoiceImageFixtures.map((name) =>
      readFile(new URL(`../test-invoices/${name}`, import.meta.url)),
    ),
  );
  const bucket = supabase.storage.from("invoice-images");
  const paths = seedImagePaths(scans);

  for (let index = 0; index < paths.length; index += 1) {
    const { error } = await bucket.upload(
      paths[index],
      fixtures[index % fixtures.length],
      { contentType: "image/jpeg", upsert: true },
    );
    if (error) {
      throw new Error(`invoice image upload failed: ${error.message}`);
    }
  }
}

async function seed() {
  assertWriteAllowed();
  const dryRows = buildRows();
  printPlan(dryRows);
  if (!CONFIRM) return;

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const userIds = await ensureUsers(supabase);
  const rows = buildRows(userIds);

  await upsertRows(supabase, "restaurants", [rows.restaurant]);

  const memberships = USERS.map((user) => ({
    user_id: userIds[user.role],
    restaurant_id: RESTAURANT_ID,
    role: user.role,
  }));
  await upsertRows(supabase, "memberships", memberships, {
    onConflict: "user_id,restaurant_id",
  });

  await upsertRows(supabase, "cellar_config", rows.cellarConfig);
  await upsertRows(supabase, "wines", rows.wines);
  await upsertRows(supabase, "invoice_scans", rows.scans);
  await seedInvoiceImages(supabase, rows.scans);
  await upsertRows(supabase, "inventory_items", rows.inventoryItems);
  await upsertRows(supabase, "wine_lists", rows.lists);
  await upsertRows(supabase, "wine_list_sections", rows.wineListSections);
  await upsertRows(supabase, "wine_list_items", rows.listItems);
  await upsertRows(supabase, "pour_events", rows.pourEvents);
  await upsertRows(supabase, "open_bottles", rows.openBottles, {
    onConflict: "wine_id,restaurant_id",
  });
  await upsertRows(supabase, "availability_events", rows.availabilityEvents);
  await upsertRows(supabase, "invitations", rows.invitations);

  // The wines above are upserted straight into the table, not created
  // through find_or_create_wines_batch, so nothing resolves their identity
  // on the way in. Without this call a freshly seeded stack reproduces the
  // exact state 0135 exists to fix — 250 wines, zero wine_variant_id, zero
  // canonical_wine_id, and an empty canonical_wines — which is what every
  // CI run and every local reset would then be testing against.
  const { data: resolved, error: backfillError } = await supabase.rpc(
    "backfill_wine_identity",
    { p_restaurant_id: RESTAURANT_ID },
  );
  if (backfillError) {
    throw new Error(
      `wine identity backfill failed: ${backfillError.message}. The seed is ` +
        "not complete without it — see supabase/migrations/0135.",
    );
  }
  console.log(`Resolved wine identity for ${resolved ?? 0} wine(s).`);

  console.log("Seed complete.");
  console.log(`Set DEV_BYPASS_EMAIL=${USERS[0].email} for owner login.`);
}

async function teardown() {
  assertWriteAllowed();
  const rows = buildRows();
  printPlan(rows);
  if (!CONFIRM) return;

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const { error: storageError } = await supabase.storage
    .from("invoice-images")
    .remove(seedImagePaths(rows.scans));
  if (storageError) throw storageError;

  const { error } = await supabase
    .from("restaurants")
    .delete()
    .eq("id", RESTAURANT_ID);
  if (error) throw error;

  const users = await listAllUsers(supabase);
  for (const seedUser of USERS) {
    const found = users.find(
      (user) => user.email?.toLowerCase() === seedUser.email.toLowerCase(),
    );
    if (!found) continue;
    const { error: deleteError } = await supabase.auth.admin.deleteUser(found.id);
    if (deleteError) throw deleteError;
  }

  console.log("Teardown complete.");
}

if (TEARDOWN) {
  teardown().catch((error) => {
    console.error(error.message ?? error);
    process.exit(1);
  });
} else {
  seed().catch((error) => {
    console.error(error.message ?? error);
    process.exit(1);
  });
}
