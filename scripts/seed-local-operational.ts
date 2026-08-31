#!/usr/bin/env -S pnpm exec tsx
/**
 * Seed the OPERATIONAL tables the demo restaurant never got — the ones
 * behind /bins, /insights, /cellar/reconcile, /reconcile-queue, /import and
 * the brand-kit panel under /lists/[id]. Companion to
 * scripts/seed-local-supabase.mjs, which seeds the *catalogue* half of the
 * world (restaurant, wines, inventory, lists, scans, pours). That script is
 * the source of truth for conventions this one follows: dry run by default,
 * --confirm to write, deterministic `uuid(prefix, index)` ids so a re-run
 * upserts in place instead of duplicating, and the assert-local-db gate
 * before any write.
 *
 * WHY TypeScript, when the sibling seeder is .mjs: two of these tables
 * (cellar_health, pricing_recommendations) are DERIVED — the product
 * computes them from wines/inventory/pours via runCellarHealthRecompute and
 * runPricingRecommendationsRecompute. Re-implementing that classification in
 * a seeder would be inventing a second, drifting source of truth for the
 * numbers Insights and the pricing panel show. So this script imports the
 * real functions and runs them, exactly as POST /api/cellar-health/recompute
 * does. That needs the `@/` alias, hence tsx (same lane as scripts/seed-lwin.ts
 * and scripts/seed-xwines.ts).
 *
 * Prerequisite it also fixes: the demo restaurant has NO reason_codes.
 * stock_adjustments.reason_code_id is NOT NULL and a written-off closeout
 * needs one too, so neither table can be seeded without them. The seven
 * codes written here are copied verbatim from public.seed_reason_codes()
 * (0053) — the canonical set every real restaurant gets from the signup
 * trigger. The demo restaurant was inserted directly, so the trigger never
 * fired, and the function itself is `revoke execute ... from public, anon,
 * authenticated` (0055 V6), so service_role cannot call it.
 *
 * Two things this script deliberately does NOT do by default:
 *
 *   1. It does not put inventory into the bins it creates. That is an
 *      UPDATE on inventory_items, which other work is touching
 *      concurrently. Pass --place-inventory (with --confirm) to do it —
 *      /bins reads occupancy through inventory_items.bin_id, so without it
 *      every bin renders "0 wines · 0 bottles" and the whole cellar shows
 *      as unplaced.
 *   2. It does not close any open_bottles. The closeouts below are
 *      historical (open_bottle_id = null), which is a shape the yield
 *      report already handles (it falls back to the closeout's own id).
 *
 * Known demo hazard, stated plainly: the completed import batches carry
 * rows with apply_status = 'applied' pointing at real inventory_items —
 * that is the only shape the schema allows (0076: applied ⇒
 * applied_inventory_item_id IS NOT NULL), and it is what a genuinely
 * completed import looks like. Reverting one of those batches in the UI
 * therefore DELETES those inventory_items (0109). That is real product
 * behaviour, not a seeding artefact, but on a demo stack it is a live
 * trigger — re-run scripts/seed-local-supabase.mjs to recover.
 *
 * Usage:
 *   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:57321 \
 *   SUPABASE_SERVICE_ROLE_KEY=... \
 *   pnpm exec tsx scripts/seed-local-operational.ts [--confirm] [--place-inventory]
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";

import { runCellarHealthRecompute } from "@/lib/cellar-health/recompute";
import { runPricingRecommendationsRecompute } from "@/lib/pricing-recommendations/recompute";
import {
  MenuThemeProposalsSchema,
  validateThemeContrast,
  type MenuTheme,
} from "@/lib/branding/theme";
import type { CanonicalHeader } from "@/domains/import/constants";
import type { Database } from "@/types/database";

config({ path: ".env.local" });

const args = new Set(process.argv.slice(2));
const CONFIRM = args.has("--confirm");
const PLACE_INVENTORY = args.has("--place-inventory");

// No hardcoded fallback, for the same reason seed-local-supabase.mjs has
// none: several local Supabase stacks run on this machine on different
// ports, and a default here risked seeding the wrong one.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
if (!SUPABASE_URL) {
  console.error(
    "Refusing to run: NEXT_PUBLIC_SUPABASE_URL is not set (checked env + .env.local).",
  );
  process.exit(1);
}
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const PROD_URL_PATTERN = process.env.PROD_SUPABASE_URL_PATTERN ?? "";

const RESTAURANT_ID =
  process.env.LOCAL_SEED_RESTAURANT_ID ??
  "de100000-0000-4000-8000-000000000001";

/** Continues scripts/seed-local-supabase.mjs's UUID_PREFIX map (which ends
 * at de10000c). Every id this script writes is recognisably seed data and
 * stable across re-runs. */
const UUID_PREFIX = {
  bin: "de10000d",
  brandKit: "de10000e",
  importSession: "de10000f",
  importBatch: "de100010",
  importRow: "de100011",
  reconcileBatch: "de100012",
  reconcileAction: "de100013",
  stockAdjustment: "de100014",
  closeout: "de100015",
  job: "de100016",
  reasonCode: "de100017",
} as const;

function uuid(prefix: string, index: number): string {
  return `${prefix}-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

/** Anchored to UTC midday of the day the seeder runs, so a demo always
 * looks current and a same-day re-run is byte-identical. */
const TODAY = (() => {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  return d;
})();

function dayOffset(daysAgo: number): string {
  const d = new Date(TODAY);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString();
}

function hoursAgo(daysAgo: number, hour: number): string {
  const d = new Date(TODAY);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  d.setUTCHours(hour, (daysAgo * 7) % 60, 0, 0);
  return d.toISOString();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function money(amount: number): number {
  return Number(amount.toFixed(2));
}

function isLocalUrl(rawUrl: string): boolean {
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

function assertWriteAllowed(): void {
  if (!CONFIRM) return;
  if (!SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required for --confirm.");
  }
  if (PROD_URL_PATTERN && SUPABASE_URL!.includes(PROD_URL_PATTERN)) {
    throw new Error(
      `Refusing to seed: target URL matches PROD_SUPABASE_URL_PATTERN (${PROD_URL_PATTERN}).`,
    );
  }
  if (!isLocalUrl(SUPABASE_URL!)) {
    throw new Error("Refusing to seed a non-local Supabase URL.");
  }
  // The hard gate: must be THIS repo's local stack on THIS repo's port, not
  // merely "some" localhost port. Shared with dev-stack.sh and
  // seed-local-supabase.mjs rather than re-implemented here.
  execFileSync("bash", ["scripts/local/assert-local-db.sh"], {
    env: process.env,
    stdio: "inherit",
  });
}

type Client = SupabaseClient<Database>;

// ── World the seed reads (never writes) ────────────────────────────────

type WineRow = {
  id: string;
  producer: string;
  name: string;
  vintage: number | null;
  varietal: string | null;
  region: string | null;
  country: string | null;
  size_ml: number;
  colour: string | null;
  lwin_id: string | null;
};

type InventoryRow = {
  id: string;
  wine_id: string;
  quantity: number;
  unit_cost: number;
  currency: string | null;
};

type World = {
  wines: WineRow[];
  wineById: Map<string, WineRow>;
  inventory: InventoryRow[];
  users: { owner: string; manager: string; staff: string };
  scanIds: string[];
  listIds: string[];
  reasonCodeIds: Map<string, string>;
};

async function loadWorld(supabase: Client): Promise<World> {
  const [wines, inventory, memberships, scans, lists] = await Promise.all([
    supabase
      .from("wines")
      .select("id, producer, name, vintage, varietal, region, country, size_ml, colour, lwin_id")
      .eq("restaurant_id", RESTAURANT_ID)
      .order("id"),
    supabase
      .from("inventory_items")
      .select("id, wine_id, quantity, unit_cost, currency")
      .eq("restaurant_id", RESTAURANT_ID)
      .order("id"),
    supabase
      .from("memberships")
      .select("user_id, role")
      .eq("restaurant_id", RESTAURANT_ID),
    supabase
      .from("invoice_scans")
      .select("id")
      .eq("restaurant_id", RESTAURANT_ID)
      .order("id")
      .limit(20),
    supabase
      .from("wine_lists")
      .select("id")
      .eq("restaurant_id", RESTAURANT_ID)
      .order("id"),
  ]);

  for (const result of [wines, inventory, memberships, scans, lists]) {
    if (result.error) throw new Error(`world read failed: ${result.error.message}`);
  }

  const wineRows = (wines.data ?? []) as WineRow[];
  if (wineRows.length === 0) {
    throw new Error(
      "No wines for the demo restaurant — run scripts/seed-local-supabase.mjs --confirm first.",
    );
  }

  const byRole = new Map(
    (memberships.data ?? []).map((m) => [m.role as string, m.user_id as string]),
  );
  const owner = byRole.get("owner");
  const manager = byRole.get("manager") ?? owner;
  const staff = byRole.get("staff") ?? owner;
  if (!owner || !manager || !staff) {
    throw new Error("Demo restaurant has no owner membership — seed the base world first.");
  }

  return {
    wines: wineRows,
    wineById: new Map(wineRows.map((w) => [w.id, w])),
    inventory: (inventory.data ?? []) as InventoryRow[],
    users: { owner, manager, staff },
    scanIds: (scans.data ?? []).map((s) => s.id as string),
    listIds: (lists.data ?? []).map((l) => l.id as string),
    reasonCodeIds: new Map(),
  };
}

// ── reason_codes (prerequisite, not a target surface) ──────────────────

/** Verbatim from public.seed_reason_codes() in 0053. Ids are deterministic
 * here (the function lets the default generate them) so a re-run of this
 * script is an upsert, not a duplicate-key failure. */
const REASON_CODES = [
  ["comp_guest", "Comped — guest recovery", "comp"],
  ["comp_industry", "Comped — industry / VIP", "comp"],
  ["spill", "Spilled / broken", "spill"],
  ["training", "Staff training / tasting", "training"],
  ["spoilage", "Corked / oxidised / spoiled", "spoilage"],
  ["count_adjust", "Count correction", "adjustment"],
  ["other", "Other", "other"],
] as const;

function buildReasonCodes() {
  return REASON_CODES.map(([code, label, category], index) => ({
    id: uuid(UUID_PREFIX.reasonCode, index + 1),
    restaurant_id: RESTAURANT_ID,
    code,
    label,
    category,
    active: true,
    created_at: dayOffset(180),
  }));
}

// ── bins ───────────────────────────────────────────────────────────────

/** A plausible physical layout for a 250-label osteria list: a walk-in with
 * eight racks, a service reach-in, back bar, a locked reserve cage, the
 * Coravin station, and the sparkling fridge. `priority` is what
 * suggestPutAway sorts on (higher = offered first), so the fast-moving
 * service zones outrank deep storage. */
const BIN_ZONES = [
  { zone: "Main Cellar", prefix: "A", count: 8, capacity: 48, priority: 20 },
  { zone: "Reach-In", prefix: "R", count: 4, capacity: 24, priority: 50 },
  { zone: "Back Bar", prefix: "BB", count: 3, capacity: 12, priority: 60 },
  { zone: "Reserve Cage", prefix: "RC", count: 4, capacity: 18, priority: 10 },
  { zone: "Coravin Station", prefix: "CV", count: 2, capacity: 8, priority: 70 },
  { zone: "Sparkling Fridge", prefix: "SP", count: 2, capacity: 18, priority: 40 },
] as const;

function buildBins() {
  const rows: Array<Record<string, unknown>> = [];
  let index = 0;
  for (const zone of BIN_ZONES) {
    for (let n = 1; n <= zone.count; n += 1) {
      index += 1;
      rows.push({
        id: uuid(UUID_PREFIX.bin, index),
        restaurant_id: RESTAURANT_ID,
        code: `${zone.prefix}${n}`,
        zone: zone.zone,
        capacity: zone.capacity,
        priority: zone.priority,
        sort_order: index,
        retired_at: null,
        created_at: dayOffset(180),
        updated_at: dayOffset(180),
      });
    }
  }
  // Two retired bins: every read path filters `retired_at is null`, and a
  // seed with none of them never exercises that filter.
  for (const [code, zone] of [["A9", "Main Cellar"], ["TEMP1", "Back Bar"]]) {
    index += 1;
    rows.push({
      id: uuid(UUID_PREFIX.bin, index),
      restaurant_id: RESTAURANT_ID,
      code,
      zone,
      capacity: 24,
      priority: 0,
      sort_order: index,
      retired_at: dayOffset(45),
      created_at: dayOffset(180),
      updated_at: dayOffset(45),
    });
  }
  return rows;
}

function activeBinIds(bins: Array<Record<string, unknown>>): string[] {
  return bins.filter((b) => b.retired_at === null).map((b) => b.id as string);
}

// ── brand_kits ─────────────────────────────────────────────────────────

const BRAND_PALETTE = ["#4A1E28", "#C9A227", "#1B1E24", "#F3E7D3", "#2F5D3A"];

/** Four proposals, the shape POST /api/brand-kit/propose stores. Every
 * foreground/background pair is checked against the product's own
 * validateThemeContrast below — a theme that fails WCAG AA is silently
 * dropped by parseStoredProposals, which would leave the panel showing
 * fewer than the three MenuThemeProposalsSchema requires (i.e. none). */
const MENU_THEMES: MenuTheme[] = [
  {
    version: 1,
    name: "Osteria Ivory",
    palette: {
      background: "#FBF7F0",
      surface: "#F1E9DC",
      text: "#1F1A15",
      mutedText: "#56493C",
      accent: "#7A2E3B",
      border: "#D9CDBA",
    },
    typography: { heading: "Cormorant Garamond", body: "Source Sans 3" },
    spacing: { scale: "comfortable" },
  },
  {
    version: 1,
    name: "Cellar Slate",
    palette: {
      background: "#1B1E24",
      surface: "#262B33",
      text: "#F2F0EC",
      mutedText: "#B9BFC7",
      accent: "#D9A441",
      border: "#3A414B",
    },
    typography: { heading: "Playfair Display", body: "Inter" },
    spacing: { scale: "compact" },
  },
  {
    version: 1,
    name: "Vermiglio",
    palette: {
      background: "#FFFDF8",
      surface: "#F6EFE6",
      text: "#2A1A1C",
      mutedText: "#5C4247",
      accent: "#8C1C2B",
      border: "#E2D5C6",
    },
    typography: { heading: "Libre Baskerville", body: "Montserrat" },
    spacing: { scale: "spacious" },
  },
  {
    version: 1,
    name: "Alba Green",
    palette: {
      background: "#F7F8F4",
      surface: "#E9EDE3",
      text: "#1D241C",
      mutedText: "#4A5446",
      accent: "#2F5D3A",
      border: "#CBD3C2",
    },
    typography: { heading: "Lora", body: "Inter" },
    spacing: { scale: "comfortable" },
  },
];

/** A real, decodable 160x80 PNG so the panel renders a logo rather than a
 * bare palette strip: a cream ring on the house plum. Built here rather
 * than committed as a fixture because it is three colours and ~20 lines,
 * and a binary asset in the repo for a local-only demo seed is worse. */
function buildLogoDataUrl(): string {
  const width = 160;
  const height = 80;
  const plum = [0x4a, 0x1e, 0x28];
  const cream = [0xf3, 0xe7, 0xd3];
  const gold = [0xc9, 0xa2, 0x27];

  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0; // filter type 0 (None)
    for (let x = 0; x < width; x += 1) {
      const dx = x - width / 2;
      const dy = y - height / 2;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const colour =
        distance > 30 ? plum : distance > 24 ? cream : distance > 9 ? plum : gold;
      const offset = rowStart + 1 + x * 3;
      raw[offset] = colour[0];
      raw[offset + 1] = colour[1];
      raw[offset + 2] = colour[2];
    }
  }

  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(typed) >>> 0);
    return Buffer.concat([length, typed, checksum]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // non-interlaced

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

function buildBrandKit() {
  const failures = MENU_THEMES.flatMap((theme) =>
    validateThemeContrast(theme).map((failure) => `${theme.name}: ${failure.pair} = ${failure.ratio.toFixed(2)}:1`),
  );
  if (failures.length > 0) {
    throw new Error(`Seed menu themes fail WCAG AA:\n  ${failures.join("\n  ")}`);
  }
  // Same gate parseStoredProposals applies on read — fail here, loudly,
  // rather than storing proposals the panel will silently drop.
  MenuThemeProposalsSchema.parse(MENU_THEMES);

  return [{
    id: uuid(UUID_PREFIX.brandKit, 1),
    restaurant_id: RESTAURANT_ID,
    logo_url: buildLogoDataUrl(),
    palette: { colors: BRAND_PALETTE },
    proposals: MENU_THEMES,
    created_at: dayOffset(30),
    updated_at: dayOffset(6),
  }];
}

// ── import sessions / batches / rows ───────────────────────────────────

type BatchPlan = {
  index: number;
  filename: string;
  status: "created" | "applying" | "completed" | "reverted";
  sessionIndex: number | null;
  chunkIndex: number | null;
  chunkTotal: number | null;
  daysAgo: number;
  /** Rows drawn from real inventory and marked applied — the shape a
   * completed import leaves behind. */
  appliedCount: number;
  /** Rows that never applied: pending LWIN review, missing cost, errors. */
  unappliedCount: number;
  revertedRows: boolean;
};

const BATCH_PLANS: BatchPlan[] = [
  { index: 1, filename: "opening-inventory-part-1.csv", status: "completed", sessionIndex: 1, chunkIndex: 1, chunkTotal: 3, daysAgo: 96, appliedCount: 40, unappliedCount: 0, revertedRows: false },
  { index: 2, filename: "opening-inventory-part-2.csv", status: "completed", sessionIndex: 1, chunkIndex: 2, chunkTotal: 3, daysAgo: 96, appliedCount: 38, unappliedCount: 2, revertedRows: false },
  { index: 3, filename: "opening-inventory-part-3.csv", status: "completed", sessionIndex: 1, chunkIndex: 3, chunkTotal: 3, daysAgo: 95, appliedCount: 32, unappliedCount: 0, revertedRows: false },
  { index: 4, filename: "spring-restock-skurnik.csv", status: "completed", sessionIndex: 2, chunkIndex: 1, chunkTotal: 2, daysAgo: 12, appliedCount: 24, unappliedCount: 0, revertedRows: false },
  { index: 5, filename: "spring-restock-polaner.csv", status: "created", sessionIndex: 2, chunkIndex: 2, chunkTotal: 2, daysAgo: 2, appliedCount: 0, unappliedCount: 18, revertedRows: false },
  { index: 6, filename: "bin-audit-2026-06.csv", status: "reverted", sessionIndex: null, chunkIndex: null, chunkTotal: null, daysAgo: 34, appliedCount: 0, unappliedCount: 16, revertedRows: true },
];

const SESSION_PLANS = [
  { index: 1, label: "Opening inventory — Osteria Scala", status: "completed", declaredChunkTotal: 3, daysAgo: 96 },
  { index: 2, label: "Spring restock — Skurnik + Polaner", status: "in_progress", declaredChunkTotal: 2, daysAgo: 12 },
] as const;

/** import_batch_rows.raw is exactly the validator's RawRowFields: every
 * canonical CSV column, present, string-or-null. Typed off the product's
 * own CanonicalHeader union so a new column can never silently go missing
 * from seeded rows. */
type RawRow = Record<CanonicalHeader, string | null>;

function rawFromWine(
  wine: WineRow,
  quantity: number,
  unitCost: number | null,
  binCode: string | null,
  section: string | null,
): RawRow {
  return {
    producer: wine.producer,
    name: wine.name,
    vintage: wine.vintage === null ? null : String(wine.vintage),
    varietal: wine.varietal,
    region: wine.region,
    country: wine.country,
    size_ml: String(wine.size_ml),
    format: wine.size_ml === 1500 ? "magnum" : wine.size_ml === 375 ? "half" : "750ml",
    currency: "USD",
    quantity: String(quantity),
    unit_cost: unitCost === null ? null : unitCost.toFixed(2),
    bin: binCode,
    section,
  };
}

const SECTIONS = [
  "Sparkling", "Whites", "Rose", "Reds - Old World",
  "Reds - New World", "Dessert & Fortified",
];

function buildImportWorld(world: World, binCodes: string[]) {
  const sessions = SESSION_PLANS.map((plan) => ({
    id: uuid(UUID_PREFIX.importSession, plan.index),
    restaurant_id: RESTAURANT_ID,
    created_by: world.users.manager,
    label: plan.label,
    source_sha256: sha256(`terroir-seed:session:${plan.index}`),
    declared_chunk_total: plan.declaredChunkTotal,
    status: plan.status,
    created_at: dayOffset(plan.daysAgo),
    updated_at: dayOffset(Math.max(0, plan.daysAgo - 1)),
  }));

  const batches: Array<Record<string, unknown>> = [];
  const rows: Array<Record<string, unknown>> = [];

  // Applied rows are built FROM real inventory_items so the row's raw text
  // and the item it claims to have created actually agree. Walking the
  // inventory in id order keeps the partition stable across re-runs.
  let inventoryCursor = 0;
  let rowId = 0;

  for (const plan of BATCH_PLANS) {
    const batchId = uuid(UUID_PREFIX.importBatch, plan.index);
    const total = plan.appliedCount + plan.unappliedCount;

    batches.push({
      id: batchId,
      restaurant_id: RESTAURANT_ID,
      created_by: world.users.manager,
      filename: plan.filename,
      status: plan.status,
      total_rows: total,
      reverted_at: plan.status === "reverted" ? dayOffset(plan.daysAgo - 1) : null,
      reverted_by: plan.status === "reverted" ? world.users.owner : null,
      created_at: dayOffset(plan.daysAgo),
      updated_at: dayOffset(Math.max(0, plan.daysAgo - 1)),
      session_id: plan.sessionIndex === null ? null : uuid(UUID_PREFIX.importSession, plan.sessionIndex),
      chunk_index: plan.chunkIndex,
      chunk_total: plan.chunkTotal,
      // The digest trigger (0129) only accepts a bare 64-hex sha or the
      // overrides-v1 triple; anything else refuses the insert outright.
      content_sha256: sha256(`terroir-seed:batch:${plan.index}:${plan.filename}`),
    });

    let rowNumber = 0;

    for (let i = 0; i < plan.appliedCount; i += 1) {
      const item = world.inventory[inventoryCursor % world.inventory.length];
      inventoryCursor += 1;
      const wine = world.wineById.get(item.wine_id);
      if (!wine) continue;
      rowNumber += 1;
      rowId += 1;
      const matched = rowId % 3 !== 0;
      rows.push({
        id: uuid(UUID_PREFIX.importRow, rowId),
        batch_id: batchId,
        restaurant_id: RESTAURANT_ID,
        row_number: rowNumber,
        raw: rawFromWine(
          wine,
          item.quantity,
          item.unit_cost,
          binCodes[rowId % binCodes.length],
          SECTIONS[rowId % SECTIONS.length],
        ),
        row_state: "valid",
        validation_errors: [],
        lwin_status: matched ? "matched" : "unmatched",
        lwin_id: matched ? wine.lwin_id : null,
        lwin_score: matched ? Number((0.82 + (rowId % 17) / 100).toFixed(2)) : null,
        cost_status: "present",
        resolution: "auto",
        manual_unit_cost: null,
        apply_status: "applied",
        applied_inventory_item_id: item.id,
        applied_wine_id: item.wine_id,
        resolved_at: dayOffset(plan.daysAgo),
        resolved_by: world.users.manager,
        created_at: dayOffset(plan.daysAgo),
        updated_at: dayOffset(plan.daysAgo),
      });
    }

    for (let i = 0; i < plan.unappliedCount; i += 1) {
      // Unapplied rows describe wines the file proposed that never became
      // inventory — drawn from the far end of the catalogue so they never
      // collide with the applied partition above.
      const wine = world.wines[(world.wines.length - 1 - (rowId % world.wines.length))];
      rowNumber += 1;
      rowId += 1;

      const flavour = i % 4;
      const isError = flavour === 3;
      const costMissing = flavour === 2;
      const pending = flavour === 1;

      rows.push({
        id: uuid(UUID_PREFIX.importRow, rowId),
        batch_id: batchId,
        restaurant_id: RESTAURANT_ID,
        row_number: rowNumber,
        raw: rawFromWine(
          wine,
          isError ? 0 : 6 + (rowId % 7),
          costMissing || isError ? null : money(24 + (rowId % 40) * 1.75),
          binCodes[rowId % binCodes.length],
          SECTIONS[rowId % SECTIONS.length],
        ),
        row_state: isError ? "error" : "valid",
        validation_errors: isError
          ? [{ field: "quantity", message: "Quantity must be a whole number, without decimals." }]
          : [],
        lwin_status: pending ? "unmatched" : "matched",
        lwin_id: pending ? null : wine.lwin_id,
        lwin_score: pending ? null : Number((0.61 + (rowId % 23) / 100).toFixed(2)),
        cost_status: costMissing ? "missing" : "present",
        // The error check constraint requires row_state 'error' ⇒
        // resolution 'exclude'; everything else stays operator-facing.
        resolution: isError ? "exclude" : pending || costMissing ? "pending" : "include",
        manual_unit_cost: costMissing ? null : null,
        apply_status: plan.revertedRows ? "reverted" : "not_applied",
        applied_inventory_item_id: null,
        applied_wine_id: null,
        resolved_at: null,
        resolved_by: null,
        created_at: dayOffset(plan.daysAgo),
        updated_at: dayOffset(plan.daysAgo),
      });
    }
  }

  return { sessions, batches, rows };
}

// ── reconcile batches / actions ────────────────────────────────────────

/** Six end-of-service reconciliations, one of them undone. Every action is
 * a `dismiss`: dismiss carries an empty patch, so prior_state/new_state are
 * `{}` — exactly what acceptBatch records — and an undo of one touches no
 * subject row. Seeding place_bin or match_scan actions instead would write
 * snapshots that no longer describe the live inventory_items/invoice_scans
 * row, and the very next Undo would fail the ledger's conflict check. */
const RECONCILE_PLANS = [
  { index: 1, daysAgo: 31, actions: 6, undoneDaysAgo: null },
  { index: 2, daysAgo: 24, actions: 4, undoneDaysAgo: null },
  { index: 3, daysAgo: 17, actions: 7, undoneDaysAgo: 17 },
  { index: 4, daysAgo: 10, actions: 3, undoneDaysAgo: null },
  { index: 5, daysAgo: 4, actions: 5, undoneDaysAgo: null },
  { index: 6, daysAgo: 1, actions: 2, undoneDaysAgo: null },
] as const;

function buildReconcile(world: World) {
  const batches: Array<Record<string, unknown>> = [];
  const actions: Array<Record<string, unknown>> = [];
  let actionId = 0;

  for (const plan of RECONCILE_PLANS) {
    const batchId = uuid(UUID_PREFIX.reconcileBatch, plan.index);
    batches.push({
      id: batchId,
      restaurant_id: RESTAURANT_ID,
      created_by: plan.index % 2 === 0 ? world.users.manager : world.users.owner,
      action_count: plan.actions,
      created_at: hoursAgo(plan.daysAgo, 23),
      undone_at: plan.undoneDaysAgo === null ? null : hoursAgo(plan.undoneDaysAgo, 23),
      undone_by: plan.undoneDaysAgo === null ? null : world.users.owner,
    });

    for (let ordinal = 0; ordinal < plan.actions; ordinal += 1) {
      actionId += 1;
      const wine = world.wines[actionId % world.wines.length];
      actions.push({
        id: uuid(UUID_PREFIX.reconcileAction, actionId),
        batch_id: batchId,
        restaurant_id: RESTAURANT_ID,
        action_type: "dismiss",
        subject_table: "wines",
        subject_id: wine.id,
        prior_state: {},
        new_state: {},
        ordinal,
        created_at: hoursAgo(plan.daysAgo, 23),
      });
    }
  }
  return { batches, actions };
}

// ── stock_adjustments ──────────────────────────────────────────────────

const ADJUSTMENT_SCRIPT = [
  { code: "comp_guest", kind: "comp", note: "Corked bottle replaced at table 12." },
  { code: "comp_industry", kind: "comp", note: "Somm visit — two glasses to the kitchen." },
  { code: "training", kind: "adjustment", note: "Pre-service staff tasting." },
  { code: "spill", kind: "adjustment", note: "Bottle broken racking the reach-in." },
  { code: "spoilage", kind: "adjustment", note: "Oxidised on the Coravin — pulled from BTG." },
  { code: "count_adjust", kind: "adjustment", note: "Physical count off by one in RC2." },
  { code: "comp_guest", kind: "comp", note: "Anniversary pour, comped by the owner." },
  { code: "other", kind: "adjustment", note: "Moved to the private-event allocation." },
] as const;

function buildStockAdjustments(world: World) {
  const userIds = [world.users.staff, world.users.manager, world.users.owner];
  return Array.from({ length: 48 }, (_, i) => {
    const beat = ADJUSTMENT_SCRIPT[i % ADJUSTMENT_SCRIPT.length];
    const wine = world.wines[(i * 7) % world.wines.length];
    const reasonId = world.reasonCodeIds.get(beat.code);
    if (!reasonId) throw new Error(`missing reason code ${beat.code}`);
    // Comps and training come out of an open bottle (ml); breakage and
    // count corrections move whole bottles. Never both zero — the
    // stock_adjustments_nonzero check.
    const asMl = beat.kind === "comp" || beat.code === "training";
    return {
      id: uuid(UUID_PREFIX.stockAdjustment, i + 1),
      restaurant_id: RESTAURANT_ID,
      wine_id: wine.id,
      kind: beat.kind,
      bottles: asMl ? 0 : i % 5 === 0 ? -2 : -1,
      ml: asMl ? -(120 + (i % 4) * 30) : 0,
      reason_code_id: reasonId,
      acting_user_id: userIds[i % userIds.length],
      note: beat.note,
      created_at: hoursAgo(60 - (i % 60), 19 + (i % 4)),
    };
  });
}

// ── bottle_closeouts ───────────────────────────────────────────────────

const PRESERVATION_CYCLE = ["coravin", "argon", "vacuum", "none"] as const;

function buildCloseouts(world: World) {
  const userIds = [world.users.staff, world.users.manager, world.users.owner];
  return Array.from({ length: 32 }, (_, i) => {
    const wine = world.wines[(i * 11 + 3) % world.wines.length];
    const method = PRESERVATION_CYCLE[i % PRESERVATION_CYCLE.length];
    const size = wine.size_ml;
    // Vary on the index WITHIN the method, not on `i`. Because the method
    // cycles every four rows, anything keyed off `i % 4` is constant for a
    // given method — which rendered all eight argon bottles as the same
    // "458 ml actual / 450 ml theoretical" line in the yield report.
    const k = Math.floor(i / PRESERVATION_CYCLE.length);

    // Coravin and argon hold their pour count honestly; vacuum and no
    // preservation lose more to the glass and to the drain, which is
    // exactly the comparison the Insights yield report exists to make.
    const poured = Math.min(size - 60, 150 * (2 + (k % 4)));
    const theoretical = size - poured;
    const slipPerPour =
      method === "coravin" ? 3 : method === "argon" ? 7 : method === "vacuum" ? 15 : 26;
    const slipMl = -(slipPerPour * (k % 4) + (k % 3) * 4);
    const actual = Math.max(0, theoretical + slipMl);

    // A write-off needs a reason code (bottle_closeouts_writeoff_requires_reason).
    const writesOff = method === "none" && k % 3 === 1;
    const writtenOff = writesOff ? Math.min(actual, 90) : 0;
    const reasonId = writesOff ? world.reasonCodeIds.get("spoilage") ?? null : null;

    const closedDaysAgo = 2 + ((i * 3) % 88);
    return {
      id: uuid(UUID_PREFIX.closeout, i + 1),
      restaurant_id: RESTAURANT_ID,
      wine_id: wine.id,
      // Historical closeouts: the bottle they describe is long gone, so
      // there is no open_bottles row to point at. fetchYieldGroups already
      // falls back to the closeout's own id for the bottle key.
      open_bottle_id: null,
      preservation_method: method,
      opened_at: hoursAgo(closedDaysAgo + 2 + (i % 5), 17),
      closed_by: userIds[i % userIds.length],
      closed_at: hoursAgo(closedDaysAgo, 23),
      theoretical_remaining_ml: theoretical,
      actual_remaining_ml: actual,
      written_off_ml: writtenOff,
      reason_code_id: reasonId,
    };
  });
}

// ── background_jobs ────────────────────────────────────────────────────

/** A worker queue mid-flight. The two recompute runs at the end of this
 * script insert their own `processing` → `succeeded` rows; these cover the
 * states nothing else on a local stack ever produces (retrying, failed,
 * dead, cancelled, queued). */
function buildJobs(world: World) {
  const scan = (i: number) => world.scanIds[i % Math.max(1, world.scanIds.length)] ?? null;
  const wine = (i: number) => world.wines[i % world.wines.length].id;
  const list = (i: number) => world.listIds[i % Math.max(1, world.listIds.length)] ?? null;

  const plans: Array<{
    job_type: string;
    status: string;
    subject_table: string | null;
    subject_id: string | null;
    daysAgo: number;
    attempt_count: number;
    error_code?: string;
    error_message?: string;
    result?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }> = [
    { job_type: "invoice_extract", status: "succeeded", subject_table: "invoice_scans", subject_id: scan(0), daysAgo: 3, attempt_count: 1, result: { line_items: 14, accuracy: 0.94 }, metadata: { distributor: "Skurnik" } },
    { job_type: "invoice_extract", status: "succeeded", subject_table: "invoice_scans", subject_id: scan(1), daysAgo: 2, attempt_count: 1, result: { line_items: 9, accuracy: 0.88 }, metadata: { distributor: "Polaner" } },
    { job_type: "invoice_extract", status: "processing", subject_table: "invoice_scans", subject_id: scan(2), daysAgo: 0, attempt_count: 1, metadata: { distributor: "Vine Street" } },
    { job_type: "invoice_ocr", status: "queued", subject_table: "invoice_scans", subject_id: scan(3), daysAgo: 0, attempt_count: 0, metadata: { pages: 2 } },
    { job_type: "invoice_ocr", status: "retrying", subject_table: "invoice_scans", subject_id: scan(4), daysAgo: 0, attempt_count: 2, error_code: "ocr_timeout", error_message: "Document Intelligence timed out; retrying with backoff." },
    { job_type: "invoice_ocr", status: "failed", subject_table: "invoice_scans", subject_id: scan(5), daysAgo: 6, attempt_count: 3, error_code: "ocr_unreadable", error_message: "Scan too low-contrast to read." },
    { job_type: "invoice_ocr", status: "dead", subject_table: "invoice_scans", subject_id: scan(6), daysAgo: 21, attempt_count: 3, error_code: "ocr_unreadable", error_message: "Exhausted all attempts; needs a re-scan." },
    { job_type: "wine_enrichment", status: "succeeded", subject_table: "wines", subject_id: wine(5), daysAgo: 9, attempt_count: 1, result: { enriched: 118, skipped: 12 } },
    { job_type: "wine_enrichment", status: "processing", subject_table: "wines", subject_id: wine(40), daysAgo: 0, attempt_count: 1, metadata: { batch: "drink-window-refresh" } },
    { job_type: "wine_enrichment", status: "cancelled", subject_table: "wines", subject_id: wine(90), daysAgo: 14, attempt_count: 1, error_code: "cancelled_by_user", error_message: "Superseded by a newer enrichment run." },
    { job_type: "wine_list_pdf", status: "succeeded", subject_table: "wine_lists", subject_id: list(0), daysAgo: 5, attempt_count: 1, result: { pages: 4, bytes: 512_884 } },
    { job_type: "wine_list_pdf", status: "queued", subject_table: "wine_lists", subject_id: list(1), daysAgo: 0, attempt_count: 0, metadata: { theme: "Osteria Ivory" } },
  ];

  return plans.map((plan, i) => ({
    id: uuid(UUID_PREFIX.job, i + 1),
    restaurant_id: RESTAURANT_ID,
    created_by: world.users.manager,
    job_type: plan.job_type,
    status: plan.status,
    subject_table: plan.subject_table,
    subject_id: plan.subject_id,
    attempt_count: plan.attempt_count,
    max_attempts: 3,
    run_after: hoursAgo(plan.daysAgo, 8),
    started_at: plan.status === "queued" ? null : hoursAgo(plan.daysAgo, 8),
    finished_at: ["succeeded", "failed", "dead", "cancelled"].includes(plan.status)
      ? hoursAgo(plan.daysAgo, 9)
      : null,
    error_code: plan.error_code ?? null,
    error_message: plan.error_message ?? null,
    result: plan.result ?? {},
    metadata: plan.metadata ?? {},
    claimed_at: plan.status === "processing" ? hoursAgo(plan.daysAgo, 8) : null,
    idempotency_key: `local-seed-${i + 1}`,
    created_at: hoursAgo(plan.daysAgo, 7),
    updated_at: hoursAgo(plan.daysAgo, 9),
  }));
}

// ── write helpers ──────────────────────────────────────────────────────

async function upsertRows(
  supabase: Client,
  table: string,
  rows: Array<Record<string, unknown>>,
  options: { onConflict?: string; batchSize?: number } = {},
): Promise<void> {
  if (rows.length === 0) return;
  const batchSize = options.batchSize ?? 100;
  for (let i = 0; i < rows.length; i += batchSize) {
    const { error } = await (supabase.from(table as never) as never as {
      upsert: (r: unknown, o: unknown) => PromiseLike<{ error: { message: string } | null }>;
    }).upsert(rows.slice(i, i + batchSize), {
      onConflict: options.onConflict ?? "id",
    });
    if (error) throw new Error(`${table} upsert failed: ${error.message}`);
  }
}

/** Spread the cellar across the bins, but deliberately leave every fifth
 * item unplaced. A fully placed cellar empties /reconcile-queue of its
 * `place_bin` work, which is the one action the queue can actually offer
 * now that bins exist — so the two surfaces are only both believable when
 * some stock is still waiting to be put away. Opt-in: see the header. */
const UNPLACED_EVERY = 5;

async function placeInventory(
  supabase: Client,
  world: World,
  binIds: string[],
): Promise<{ placed: number; left: number }> {
  let placed = 0;
  let left = 0;
  for (let i = 0; i < world.inventory.length; i += 1) {
    if (i % UNPLACED_EVERY === 0) {
      left += 1;
      continue;
    }
    const { error } = await supabase
      .from("inventory_items")
      .update({ bin_id: binIds[i % binIds.length] })
      .eq("id", world.inventory[i].id)
      .eq("restaurant_id", RESTAURANT_ID);
    if (error) throw new Error(`inventory placement failed: ${error.message}`);
    placed += 1;
  }
  return { placed, left };
}

// ── main ───────────────────────────────────────────────────────────────

async function seed(): Promise<void> {
  assertWriteAllowed();

  const supabase = createClient<Database>(SUPABASE_URL!, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  }) as Client;

  const world = await loadWorld(supabase);

  const reasonCodes = buildReasonCodes();
  for (const row of reasonCodes) world.reasonCodeIds.set(row.code, row.id);

  const bins = buildBins();
  const binIds = activeBinIds(bins);
  const binCodes = bins
    .filter((b) => b.retired_at === null)
    .map((b) => b.code as string);
  const brandKits = buildBrandKit();
  const imports = buildImportWorld(world, binCodes);
  const reconcile = buildReconcile(world);
  const stockAdjustments = buildStockAdjustments(world);
  const closeouts = buildCloseouts(world);
  const jobs = buildJobs(world);

  console.log("");
  console.log(`  Target:     ${SUPABASE_URL}`);
  console.log(`  Mode:       ${CONFIRM ? "LIVE SEED" : "DRY RUN"}`);
  console.log(`  Restaurant: ${RESTAURANT_ID}`);
  console.log(`  Local URL:  ${isLocalUrl(SUPABASE_URL!) ? "yes" : "no"}`);
  console.log(`  Place inv:  ${PLACE_INVENTORY ? "YES (writes inventory_items.bin_id)" : "no"}`);
  console.log("");
  console.table([
    { table: "reason_codes (prerequisite)", rows: reasonCodes.length },
    { table: "bins", rows: bins.length },
    { table: "brand_kits", rows: brandKits.length },
    { table: "import_sessions", rows: imports.sessions.length },
    { table: "import_batches", rows: imports.batches.length },
    { table: "import_batch_rows", rows: imports.rows.length },
    { table: "reconcile_batches", rows: reconcile.batches.length },
    { table: "reconcile_actions", rows: reconcile.actions.length },
    { table: "stock_adjustments", rows: stockAdjustments.length },
    { table: "bottle_closeouts", rows: closeouts.length },
    { table: "background_jobs (authored)", rows: jobs.length },
    { table: "cellar_health", rows: "computed by recompute" },
    { table: "pricing_recommendations", rows: "computed by recompute" },
  ]);

  if (!CONFIRM) {
    console.log("DRY RUN - no writes. Pass --confirm to execute.");
    return;
  }

  await upsertRows(supabase, "reason_codes", reasonCodes, {
    onConflict: "restaurant_id,code",
  });
  await upsertRows(supabase, "bins", bins);
  await upsertRows(supabase, "brand_kits", brandKits, {
    onConflict: "restaurant_id",
  });
  await upsertRows(supabase, "import_sessions", imports.sessions);
  await upsertRows(supabase, "import_batches", imports.batches);
  await upsertRows(supabase, "import_batch_rows", imports.rows);
  await upsertRows(supabase, "reconcile_batches", reconcile.batches);
  await upsertRows(supabase, "reconcile_actions", reconcile.actions);
  await upsertRows(supabase, "stock_adjustments", stockAdjustments);
  await upsertRows(supabase, "bottle_closeouts", closeouts);
  await upsertRows(supabase, "background_jobs", jobs);

  if (PLACE_INVENTORY) {
    const { placed, left } = await placeInventory(supabase, world, binIds);
    console.log(
      `Placed ${placed} inventory item(s) into ${binIds.length} bins; left ${left} unplaced for the reconcile queue.`,
    );
  }

  // Derived tables last: cellar_health feeds pricing_recommendations
  // (recommend reads the health segment), so the order matters.
  const health = await runCellarHealthRecompute(
    supabase,
    RESTAURANT_ID,
    world.users.owner,
  );
  console.log(`cellar_health: classified ${health.classified}`, health.segments);

  const pricing = await runPricingRecommendationsRecompute(
    supabase,
    RESTAURANT_ID,
    world.users.owner,
  );
  console.log(`pricing_recommendations: ${pricing.recommended}`, pricing.classes);

  console.log("Operational seed complete.");
}

seed().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
