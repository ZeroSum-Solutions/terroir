import { isDeepStrictEqual } from "node:util";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/types/database";

export type SubjectTable = "inventory_items" | "invoice_scans" | "wines";
type InventoryRow = Database["public"]["Tables"]["inventory_items"]["Row"];
type ScanRow = Database["public"]["Tables"]["invoice_scans"]["Row"];
type WineRow = Database["public"]["Tables"]["wines"]["Row"];
type SubjectRow = InventoryRow | ScanRow | WineRow;

export type LedgerAction = {
  action_type: "place_bin" | "match_scan" | "link_lineage" | "dismiss";
  subject_table: SubjectTable;
  subject_id: string;
  patch: Record<string, unknown>;
};

type Client = SupabaseClient<Database>;

export class LedgerFailure extends Error {
  constructor(
    message: string,
    readonly kind: "not_found" | "conflict" | "internal",
    readonly details?: unknown,
  ) {
    super(message);
  }
}

function safeJson(row: SubjectRow): Json {
  return JSON.parse(JSON.stringify(row)) as Json;
}

function stateObject(state: Json): Record<string, unknown> {
  if (!state || Array.isArray(state) || typeof state !== "object") {
    throw new LedgerFailure("Invalid reconcile snapshot.", "internal");
  }
  return state as Record<string, unknown>;
}

async function readSubject(
  client: Client,
  restaurantId: string,
  table: SubjectTable,
  id: string,
): Promise<SubjectRow | null> {
  if (table === "inventory_items") {
    const { data, error } = await client.from(table).select("*")
      .eq("id", id).eq("restaurant_id", restaurantId).maybeSingle();
    if (error) throw new LedgerFailure("Subject read failed.", "internal");
    return data;
  }
  if (table === "invoice_scans") {
    const { data, error } = await client.from(table).select("*")
      .eq("id", id).eq("restaurant_id", restaurantId).maybeSingle();
    if (error) throw new LedgerFailure("Subject read failed.", "internal");
    return data;
  }
  const { data, error } = await client.from(table).select("*")
    .eq("id", id).eq("restaurant_id", restaurantId).maybeSingle();
  if (error) throw new LedgerFailure("Subject read failed.", "internal");
  return data;
}

function withoutIdentity(row: Record<string, unknown>) {
  const { id: _id, restaurant_id: _restaurantId, ...updates } = row;
  return updates;
}

async function updateSubject(
  client: Client,
  restaurantId: string,
  table: SubjectTable,
  id: string,
  patch: Record<string, unknown>,
): Promise<SubjectRow> {
  if (table === "inventory_items") {
    const { data, error } = await client.from(table).update(patch as never)
      .eq("id", id).eq("restaurant_id", restaurantId).select("*").maybeSingle();
    if (error || !data) throw new LedgerFailure("Subject update failed.", "internal");
    return data;
  }
  if (table === "invoice_scans") {
    const { data, error } = await client.from(table).update(patch as never)
      .eq("id", id).eq("restaurant_id", restaurantId).select("*").maybeSingle();
    if (error || !data) throw new LedgerFailure("Subject update failed.", "internal");
    return data;
  }
  const { data, error } = await client.from(table).update(patch as never)
    .eq("id", id).eq("restaurant_id", restaurantId).select("*").maybeSingle();
  if (error || !data) throw new LedgerFailure("Subject update failed.", "internal");
  return data;
}

async function resolvedPatch(
  client: Client,
  restaurantId: string,
  action: LedgerAction,
  prior: SubjectRow,
) {
  if (action.action_type === "place_bin") {
    const binId = action.patch.bin_id as string;
    const { data, error } = await client.from("bins").select("code")
      .eq("id", binId).eq("restaurant_id", restaurantId).is("retired_at", null)
      .maybeSingle();
    if (error) throw new LedgerFailure("Bin lookup failed.", "internal");
    if (!data) throw new LedgerFailure("Bin not found.", "not_found");
    return { bin_id: binId, bin_location: data.code };
  }
  if (action.action_type === "link_lineage") {
    const lineageId = action.patch.lineage_id as string;
    const { data, error } = await client.from("wine_lineages").select("id")
      .eq("id", lineageId).eq("restaurant_id", restaurantId).maybeSingle();
    if (error) throw new LedgerFailure("Lineage lookup failed.", "internal");
    if (!data) throw new LedgerFailure("Lineage not found.", "not_found");
    if ((prior as WineRow).lineage_id !== lineageId) {
      throw new LedgerFailure("Manual lineage linking requires a database RPC.", "conflict");
    }
  }
  if (action.action_type === "match_scan") {
    const lines = (prior as ScanRow).final_line_items;
    const lineIndex = action.patch.line_index as number;
    if (!Array.isArray(lines) || lineIndex < 0 || lineIndex >= lines.length) {
      throw new LedgerFailure("Scan line not found.", "not_found");
    }
    const line = lines[lineIndex];
    if (!line || Array.isArray(line) || typeof line !== "object") {
      throw new LedgerFailure("Scan line is invalid.", "conflict");
    }
    if (!isDeepStrictEqual(line, action.patch.expected_line)) {
      throw new LedgerFailure("Scan line changed since the queue loaded.", "conflict");
    }
    return {
      final_line_items: lines.map((item, index) => index === lineIndex
        ? { ...line, wine_id: action.patch.wine_id }
        : item),
    };
  }
  return action.patch;
}

async function createBatch(
  client: Client,
  restaurantId: string,
  userId: string,
  count: number,
) {
  const { data, error } = await client.from("reconcile_batches").insert({
    restaurant_id: restaurantId,
    created_by: userId,
    action_count: count,
  }).select("*").single();
  if (error || !data) throw new LedgerFailure("Batch creation failed.", "internal");
  return data;
}

async function createAction(
  client: Client,
  restaurantId: string,
  batchId: string,
  action: LedgerAction,
  priorState: SubjectRow,
  newState: SubjectRow,
) {
  const { data, error } = await client.from("reconcile_actions").insert({
    batch_id: batchId,
    restaurant_id: restaurantId,
    action_type: action.action_type,
    subject_table: action.subject_table,
    subject_id: action.subject_id,
    prior_state: safeJson(priorState),
    new_state: safeJson(newState),
  }).select("*").single();
  if (error || !data) throw new LedgerFailure("Action creation failed.", "internal");
  return data;
}

export async function acceptBatch(
  client: Client,
  restaurantId: string,
  userId: string,
  requested: LedgerAction[],
) {
  for (const action of requested) {
    const prior = await readSubject(client, restaurantId, action.subject_table, action.subject_id);
    if (!prior) throw new LedgerFailure("Subject not found.", "not_found");
    await resolvedPatch(client, restaurantId, action, prior);
  }
  const batch = await createBatch(client, restaurantId, userId, requested.length);
  const actions = [];
  for (const action of requested) {
    const prior = await readSubject(client, restaurantId, action.subject_table, action.subject_id);
    if (!prior) throw new LedgerFailure("Subject not found.", "not_found");
    const patch = await resolvedPatch(client, restaurantId, action, prior);
    const next = action.action_type === "dismiss"
      ? prior
      : await updateSubject(
        client, restaurantId, action.subject_table, action.subject_id, patch,
      );
    actions.push(await createAction(
      client, restaurantId, batch.id, action, prior, next,
    ));
  }
  return { batch, actions };
}

async function loadUndo(
  client: Client,
  restaurantId: string,
  batchId: string,
) {
  const { data: batch, error } = await client.from("reconcile_batches").select("*")
    .eq("id", batchId).eq("restaurant_id", restaurantId).maybeSingle();
  if (error) throw new LedgerFailure("Batch read failed.", "internal");
  if (!batch) throw new LedgerFailure("Batch not found.", "not_found");
  if (batch.undone_at) throw new LedgerFailure("Batch already undone.", "conflict");
  const { data: actions, error: actionsError } = await client
    .from("reconcile_actions").select("*").eq("batch_id", batchId)
    .eq("restaurant_id", restaurantId).order("created_at", { ascending: true });
  if (actionsError) throw new LedgerFailure("Actions read failed.", "internal");
  return { batch, actions: [...actions].reverse() };
}

export async function undoBatch(
  client: Client,
  restaurantId: string,
  userId: string,
  batchId: string,
) {
  const { batch, actions } = await loadUndo(client, restaurantId, batchId);
  const expected = new Map<string, SubjectRow>();
  const conflicts = [];
  for (const action of actions) {
    const table = action.subject_table as SubjectTable;
    const key = `${table}:${action.subject_id}`;
    const row = expected.get(key)
      ?? await readSubject(client, restaurantId, table, action.subject_id);
    if (!row || !isDeepStrictEqual(row, action.new_state)) {
      conflicts.push({ subject_table: table, subject_id: action.subject_id });
    } else {
      expected.set(key, stateObject(action.prior_state) as SubjectRow);
    }
  }
  if (conflicts.length) {
    throw new LedgerFailure("Subjects changed since reconciliation.", "conflict", { conflicts });
  }
  for (const action of actions) {
    const table = action.subject_table as SubjectTable;
    await updateSubject(
      client, restaurantId, table, action.subject_id,
      withoutIdentity(stateObject(action.prior_state)),
    );
  }
  const undoneAt = new Date().toISOString();
  const { data: closed, error } = await client.from("reconcile_batches")
    .update({ undone_at: undoneAt, undone_by: userId })
    .eq("id", batch.id).eq("restaurant_id", restaurantId)
    .is("undone_at", null).select("*").maybeSingle();
  if (error || !closed) throw new LedgerFailure("Batch close failed.", "internal");
  return closed;
}
