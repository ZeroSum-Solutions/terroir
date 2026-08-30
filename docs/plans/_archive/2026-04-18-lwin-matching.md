# LWIN Wine Matching Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire the 211k-wine LWIN catalog into the wine creation and search flows so wines get matched automatically and users can search the global catalog when adding wines to lists.

**Architecture:** Three integration points: (1) Postgres fuzzy-match function using pg_trgm trigram indexes already on lwin_catalog, (2) async LWIN matching after wine creation in save-scan, (3) LWIN catalog search in the add-wine modal. Matching is a bonus, never a gate. No existing behavior changes.

**Tech Stack:** PL/pgSQL (pg_trgm similarity), Next.js API routes, React client component

---

### Task 1: Create migration with LWIN matching functions

**Files:**
- Create: `supabase/migrations/0007_lwin_matching.sql`

**What to build:**

Three SQL functions:

**a) `match_lwin(p_producer text, p_name text, p_threshold float DEFAULT 0.3)`**

Returns one row: `(lwin_id, display_name, producer, varietal, region, country, colour, score)` or null.

```sql
create or replace function public.match_lwin(
  p_producer text,
  p_name     text,
  p_threshold float default 0.3
)
returns table (
  lwin_id      text,
  display_name text,
  producer     text,
  varietal     text,
  region       text,
  country      text,
  colour       text,
  score        float
)
language sql stable security definer set search_path = public
as $$
  select lc.lwin_id, lc.display_name, lc.producer, lc.varietal,
         lc.region, lc.country, lc.colour,
         (similarity(lower(p_producer), lower(lc.producer)) * 0.6 +
          similarity(lower(p_name), lower(lc.display_name)) * 0.4) as score
  from public.lwin_catalog lc
  where similarity(lower(p_producer), lower(lc.producer)) >= p_threshold
    and similarity(lower(p_name), lower(lc.display_name)) >= p_threshold * 0.7
  order by score desc
  limit 1;
$$;
```

Producer weighted 60% because producer names are distinctive. Wine names ("Reserve", "Grand Cru") are generic.

**b) `match_lwin_batch(p_wine_ids uuid[])`**

Loops through wine IDs where `lwin_id IS NULL`, calls `match_lwin`, updates the wine with `lwin_id` + fills null country/region/varietal from the match.

```sql
create or replace function public.match_lwin_batch(p_wine_ids uuid[])
returns table (wine_id uuid, lwin_id text, score float)
language plpgsql security definer set search_path = public
as $$
declare
  w record;
  m record;
begin
  for w in
    select id, producer, name, country, region, varietal
    from public.wines
    where id = any(p_wine_ids) and wines.lwin_id is null
  loop
    select * into m from public.match_lwin(w.producer, w.name);
    if m.lwin_id is not null then
      update public.wines set
        lwin_id  = m.lwin_id,
        country  = coalesce(wines.country, m.country),
        region   = coalesce(wines.region, m.region),
        varietal = coalesce(wines.varietal, m.varietal)
      where id = w.id;

      wine_id := w.id;
      lwin_id := m.lwin_id;
      score   := m.score;
      return next;
    end if;
  end loop;
end;
$$;
```

Only fills null fields. Never overwrites user-provided data.

**c) `lwin_search(p_query text, p_limit int DEFAULT 20)`**

Fast catalog search using the `%` trigram operator (hits GIN indexes):

```sql
create or replace function public.lwin_search(p_query text, p_limit int default 20)
returns setof public.lwin_catalog
language sql stable security definer set search_path = public
as $$
  select *
  from public.lwin_catalog
  where producer % p_query or display_name % p_query
  order by greatest(
    similarity(lower(producer), lower(p_query)),
    similarity(lower(display_name), lower(p_query))
  ) desc
  limit p_limit;
$$;
```

**Grants:** `revoke all ... from public; grant execute ... to authenticated;` for all three functions.

**Apply:** Via Supabase MCP `execute_sql` or `apply_migration`.

**Verify:** Run `select * from match_lwin('Schieferkopf', 'Riesling');` and confirm a result comes back.

---

### Task 2: Regenerate TypeScript types

**Files:**
- Modify: `src/types/database.ts`

**Step 1:** Run `supabase gen types typescript --project-id qcfmwphlaekfkqwkfyth > src/types/database.ts` or use Supabase MCP `generate_typescript_types`.

**Step 2:** Verify the new functions appear in the `Functions` section of the generated types.

---

### Task 3: Create LWIN catalog search API

**Files:**
- Create: `src/app/api/wines/lwin-search/route.ts`

**Step 1:** Create the endpoint:

```typescript
import { NextResponse, type NextRequest } from "next/server";
import { requireMembership } from "@/lib/api/auth";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase } = auth;

  const q = request.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) {
    return NextResponse.json([]);
  }

  const { data, error } = await supabase.rpc("lwin_search", {
    p_query: q,
    p_limit: 20,
  });

  if (error) {
    console.error("lwin_search failed:", error);
    return NextResponse.json([], { status: 500 });
  }

  return NextResponse.json(data ?? []);
}
```

**Verify:** `curl localhost:3000/api/wines/lwin-search?q=opus` should return Opus One and similar wines.

---

### Task 4: Add async LWIN matching to save-scan

**Files:**
- Modify: `src/app/api/inventory/save-scan/route.ts`

**Step 1:** After the successful inventory insert (after line 169 in current code), add LWIN matching:

```typescript
// LWIN matching — async, non-blocking on the response
const wineIdStrings = wineIdArray as string[];
supabase
  .rpc("match_lwin_batch", { p_wine_ids: wineIdStrings })
  .then(({ data, error }) => {
    if (error) console.error("LWIN batch match failed:", error);
    else if (data) console.log(`LWIN matched ${data.length} of ${wineIdStrings.length} wines`);
  });
```

Place this BEFORE the `return NextResponse.json(...)` call. The promise runs in the background. The response returns immediately with `scanId`, `itemCount`, `wineCount` as before.

**Verify:** Scan a test invoice, then check `select id, name, producer, lwin_id from wines where restaurant_id = '...' and lwin_id is not null;`

---

### Task 5: Extend enrich endpoint with LWIN backfill

**Files:**
- Modify: `src/app/api/wines/enrich/route.ts`

**Step 1:** After the existing enrichment Promise.all (after the `enriched` count), add LWIN backfill:

```typescript
// LWIN backfill for wines without lwin_id
const { data: unmatched } = await supabase
  .from("wines")
  .select("id")
  .eq("restaurant_id", restaurantId)
  .is("lwin_id", null);

let lwinMatched = 0;
if (unmatched && unmatched.length > 0) {
  const unmatchedIds = unmatched.map((w) => w.id);
  const { data: matches } = await supabase.rpc("match_lwin_batch", {
    p_wine_ids: unmatchedIds,
  });
  lwinMatched = matches?.length ?? 0;
}
```

**Step 2:** Update the response to include the LWIN match count:

```typescript
return NextResponse.json({
  total: wines?.length ?? 0,
  enriched,
  lwinMatched,
});
```

**Verify:** Call `POST /api/wines/enrich`, confirm response includes `lwinMatched` count.

---

### Task 6: Add LWIN catalog tab to add-wine modal

**Files:**
- Modify: `src/app/(app)/wine-list/[id]/components/add-wine-modal.tsx`

**What changes:**

a) Add a `searchMode` state: `'inventory' | 'catalog'`

b) Add a type for LWIN results:
```typescript
type LwinWine = {
  lwin_id: string;
  display_name: string;
  producer: string | null;
  varietal: string | null;
  region: string | null;
  country: string | null;
};
```

c) Add a `catalogResults` state alongside `results`.

d) In the search useEffect, fetch from the appropriate endpoint based on `searchMode`:
- `'inventory'` → `/api/wines/search?q=...` (current behavior)
- `'catalog'` → `/api/wines/lwin-search?q=...` (new)

e) Add two tab buttons below the title, above the search input:
```tsx
<div className="flex gap-xs border-b border-border px-lg">
  <button
    onClick={() => setSearchMode("inventory")}
    className={`px-sm py-xs text-[13px] font-medium border-b-2 ${
      searchMode === "inventory"
        ? "border-accent text-accent"
        : "border-transparent text-ink-muted hover:text-ink"
    }`}
  >
    My inventory
  </button>
  <button
    onClick={() => setSearchMode("catalog")}
    className={`px-sm py-xs text-[13px] font-medium border-b-2 ${
      searchMode === "catalog"
        ? "border-accent text-accent"
        : "border-transparent text-ink-muted hover:text-ink"
    }`}
  >
    LWIN catalog
  </button>
</div>
```

f) When a catalog wine is selected, create it in the restaurant's inventory first:
```typescript
const handleSelectCatalog = async (lwin: LwinWine) => {
  // Create wine in restaurant inventory via find_or_create_wines_batch
  const res = await fetch("/api/wines/create-from-lwin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(lwin),
  });
  if (!res.ok) return;
  const { id } = await res.json();
  // Set selected with the new wine ID so pricing step works
  setSelected({
    id,
    name: lwin.display_name,
    producer: lwin.producer ?? "",
    vintage: null,
    varietal: lwin.varietal,
    region: lwin.region,
  });
};
```

g) Update empty state text for catalog mode: `"No matches in LWIN catalog."` instead of `"No wines in inventory yet."`

---

### Task 7: Create wine-from-LWIN API endpoint

**Files:**
- Create: `src/app/api/wines/create-from-lwin/route.ts`

**Step 1:** POST endpoint that creates a wine from LWIN catalog data:

```typescript
import { NextResponse, type NextRequest } from "next/server";
import { requireMembership } from "@/lib/api/auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  const body = await request.json();
  const { lwin_id, display_name, producer, varietal, region, country } = body;

  if (!display_name || !lwin_id) {
    return NextResponse.json({ error: "Missing required fields." }, { status: 400 });
  }

  // Use batch RPC with a single wine
  const { data: wineIds, error } = await supabase.rpc("find_or_create_wines_batch", {
    p_restaurant_id: restaurantId,
    p_wines: [{
      name: display_name,
      producer: producer ?? "Unknown",
      vintage: null,
      varietal: varietal ?? null,
      region: region ?? null,
      country: country ?? null,
      size_ml: 750,
    }],
  });

  if (error || !wineIds?.[0]) {
    console.error("create-from-lwin failed:", error);
    return NextResponse.json({ error: "Failed to create wine." }, { status: 500 });
  }

  const wineId = (wineIds as string[])[0];

  // Set lwin_id on the wine
  await supabase
    .from("wines")
    .update({ lwin_id })
    .eq("id", wineId);

  return NextResponse.json({ id: wineId });
}
```

**Verify:** POST with a sample LWIN entry, confirm wine is created with lwin_id set.

---

## Verification

After all tasks:

1. `pnpm build` — must succeed
2. Scan a test invoice → check that wines get `lwin_id` populated in the database
3. Call `POST /api/wines/enrich` → confirm `lwinMatched` count in response
4. Open wine list editor → Add Wine modal → switch to "LWIN catalog" tab → search "Opus One" → select → confirm wine created in inventory with lwin_id
5. Query: `select count(*) from wines where lwin_id is not null;` — should show matches

## Files changed (summary)

| Action | File |
|--------|------|
| Create | `supabase/migrations/0007_lwin_matching.sql` |
| Modify | `src/types/database.ts` (regenerate) |
| Create | `src/app/api/wines/lwin-search/route.ts` |
| Modify | `src/app/api/inventory/save-scan/route.ts` |
| Modify | `src/app/api/wines/enrich/route.ts` |
| Modify | `src/app/(app)/wine-list/[id]/components/add-wine-modal.tsx` |
| Create | `src/app/api/wines/create-from-lwin/route.ts` |
