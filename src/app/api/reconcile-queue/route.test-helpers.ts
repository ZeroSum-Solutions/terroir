import type { NextRequest } from "next/server";
import { vi } from "vitest";

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;
type Filter = (row: Row) => boolean;

function project(row: Row, fields: string) {
  if (fields === "*") return structuredClone(row);
  const names = fields.split(",").map((field) => field.trim());
  return Object.fromEntries(names.map((name) => [name, row[name]]));
}

class Query {
  private filters: Filter[] = [];
  private fields = "*";
  private maxRows: number | null = null;
  private mutation: { kind: "insert" | "update"; value: Row | Row[] } | null = null;
  private orderBy: { column: string; ascending: boolean } | null = null;

  constructor(
    private readonly table: string,
    private readonly tables: Tables,
    private readonly operations: Record<string, unknown[][]>,
  ) {}

  select(fields = "*") {
    this.operations[this.table].push(["select", fields]);
    this.fields = fields;
    return this;
  }

  insert(value: Row | Row[]) {
    this.operations[this.table].push(["insert", structuredClone(value)]);
    this.mutation = { kind: "insert", value };
    return this;
  }

  update(value: Row) {
    this.operations[this.table].push(["update", structuredClone(value)]);
    this.mutation = { kind: "update", value };
    return this;
  }

  eq(column: string, value: unknown) {
    this.operations[this.table].push(["eq", column, value]);
    this.filters.push((row) => row[column] === value);
    return this;
  }

  is(column: string, value: unknown) {
    this.operations[this.table].push(["is", column, value]);
    this.filters.push((row) => row[column] === value);
    return this;
  }

  gt(column: string, value: number) {
    this.operations[this.table].push(["gt", column, value]);
    this.filters.push((row) => Number(row[column]) > value);
    return this;
  }

  order(column: string, options: { ascending: boolean }) {
    this.operations[this.table].push(["order", column, options]);
    this.orderBy = { column, ascending: options.ascending };
    return this;
  }

  limit(count: number) {
    this.operations[this.table].push(["limit", count]);
    this.maxRows = count;
    return this;
  }

  maybeSingle() {
    return this.execute().then((result) => ({
      data: result.data[0] ?? null,
      error: result.error,
    }));
  }

  single() {
    return this.execute().then((result) => ({
      data: result.data[0] ?? null,
      error: result.data.length === 1 ? result.error : { code: "PGRST116" },
    }));
  }

  then<TResult1 = { data: Row[]; error: null }>(
    resolve?: ((value: { data: Row[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
  ) {
    return this.execute().then(resolve);
  }

  private matchingRows() {
    let rows = this.tables[this.table].filter((row) =>
      this.filters.every((filter) => filter(row)),
    );
    if (this.orderBy) {
      const { column, ascending } = this.orderBy;
      rows = [...rows].sort((a, b) => {
        const compared = String(a[column]).localeCompare(String(b[column]));
        return ascending ? compared : -compared;
      });
    }
    return this.maxRows == null ? rows : rows.slice(0, this.maxRows);
  }

  private async execute() {
    if (this.mutation?.kind === "insert") {
      const values = Array.isArray(this.mutation.value)
        ? this.mutation.value
        : [this.mutation.value];
      const created = values.map((value, index) => ({
        id: value.id ?? `88888888-8888-4888-8888-${String(
          this.tables[this.table].length + index + 1,
        ).padStart(12, "0")}`,
        created_at: value.created_at ?? "2026-08-19T12:00:00.000Z",
        ...(this.table === "reconcile_batches"
          ? { undone_at: null, undone_by: null }
          : {}),
        ...structuredClone(value),
      }));
      this.tables[this.table].push(...created);
      return { data: created.map((row) => project(row, this.fields)), error: null };
    }
    const rows = this.matchingRows();
    if (this.mutation?.kind === "update") {
      for (const row of rows) Object.assign(row, structuredClone(this.mutation.value));
    }
    return { data: rows.map((row) => project(row, this.fields)), error: null };
  }
}

export function makeSupabase(seed: Tables) {
  const tables = Object.fromEntries(
    Object.entries(seed).map(([table, rows]) => [table, structuredClone(rows)]),
  ) as Tables;
  for (const table of [
    "bins",
    "inventory_items",
    "invoice_scans",
    "wine_lineages",
    "wines",
    "reconcile_batches",
    "reconcile_actions",
  ]) tables[table] ??= [];
  const operations: Record<string, unknown[][]> = {};
  const from = vi.fn((table: string) => {
    operations[table] ??= [];
    return new Query(table, tables, operations);
  });
  return { from, tables, operations };
}

export function postRequest(path: string, body: unknown): NextRequest {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }) as unknown as NextRequest;
}

export function getRequest(): NextRequest {
  return new Request("http://localhost/api/reconcile-queue") as unknown as NextRequest;
}

export const RESTAURANT_ID = "11111111-1111-4111-8111-111111111111";
export const USER_ID = "22222222-2222-4222-8222-222222222222";
export const INVENTORY_ID = "33333333-3333-4333-8333-333333333333";
export const SCAN_ID = "44444444-4444-4444-8444-444444444444";
export const WINE_ID = "55555555-5555-4555-8555-555555555555";
export const BIN_ID = "66666666-6666-4666-8666-666666666666";
export const LINEAGE_ID = "77777777-7777-4777-8777-777777777777";

export function subjectSeed() {
  return {
    bins: [{
      id: BIN_ID,
      restaurant_id: RESTAURANT_ID,
      code: "A-01",
      retired_at: null,
    }],
    inventory_items: [{
      id: INVENTORY_ID,
      restaurant_id: RESTAURANT_ID,
      wine_id: WINE_ID,
      bin_id: null,
      bin_location: null,
      quantity: 2,
      unit_cost: 45,
      format: "750ml",
      updated_at: "before",
    }],
    invoice_scans: [{
      id: SCAN_ID,
      restaurant_id: RESTAURANT_ID,
      final_line_items: [{ id: "line-1", name: "Before" }],
      status: "complete",
    }],
    wines: [{
      id: WINE_ID,
      restaurant_id: RESTAURANT_ID,
      name: "Estate Red",
      producer: "Maker",
      vintage: 2020,
      size_ml: 750,
      lineage_id: null,
    }],
    wine_lineages: [{
      id: LINEAGE_ID,
      restaurant_id: RESTAURANT_ID,
    }],
    reconcile_batches: [],
    reconcile_actions: [],
  };
}
