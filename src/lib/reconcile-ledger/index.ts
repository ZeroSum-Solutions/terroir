import { isDeepStrictEqual } from "node:util";
import type { SupabaseClient } from "@supabase/supabase-js";
import { suggestWineMatch, wineMatchIdentityFromLine } from "@/lib/reconcile-queue";
import type { Database, Json } from "@/types/database";

export type SubjectTable = "inventory_items" | "invoice_scans" | "wines";
type InventoryRow = Database["public"]["Tables"]["inventory_items"]["Row"];
type ScanRow = Database["public"]["Tables"]["invoice_scans"]["Row"];
type WineRow = Database["public"]["Tables"]["wines"]["Row"];
type ActionRow = Database["public"]["Tables"]["reconcile_actions"]["Row"];
type SubjectRow = InventoryRow | ScanRow | WineRow;
type Snapshot = Record<string, unknown>;

export type LedgerAction = {
  action_type: "place_bin" | "match_scan" | "link_lineage" | "dismiss";
  subject_table: SubjectTable;
  subject_id: string;
  patch: Record<string, unknown>;
};

type Client = SupabaseClient<Database>;
type FailureKind = "not_found" | "conflict" | "identity_mismatch" | "internal";

export class LedgerFailure extends Error {
  constructor(
    message: string,
    readonly kind: FailureKind,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

function safeJson(value: Snapshot): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

function stateObject(state: Json): Snapshot {
  if (!state || Array.isArray(state) || typeof state !== "object") {
    throw new LedgerFailure("Invalid reconcile snapshot.", "internal");
  }
  return state as Snapshot;
}

function projection(row: Snapshot, fields: readonly string[]): Snapshot {
  return Object.fromEntries(fields.map((field) => [field, row[field]]));
}

function projectedState(row: SubjectRow, patch: Snapshot): Snapshot {
  return projection(row as unknown as Snapshot, Object.keys(patch));
}

function matchesSnapshot(row: SubjectRow | Snapshot, snapshot: Snapshot): boolean {
  return isDeepStrictEqual(
    projection(row as Snapshot, Object.keys(snapshot)),
    snapshot,
  );
}

function actionDetails(action: LedgerAction, ordinal: number) {
  return {
    ordinal,
    action_type: action.action_type,
    subject_table: action.subject_table,
    subject_id: action.subject_id,
  };
}

function recordedActionDetails(action: ActionRow) {
  return {
    ordinal: action.ordinal,
    action_type: action.action_type,
    subject_table: action.subject_table,
    subject_id: action.subject_id,
  };
}

function detailsRecord(value: unknown): Record<string, unknown> {
  return value && !Array.isArray(value) && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
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

async function updateSubject(
  client: Client,
  restaurantId: string,
  table: SubjectTable,
  id: string,
  patch: Snapshot,
  expected: Snapshot,
): Promise<{ data: SubjectRow | null; error: unknown }> {
  if (Object.keys(patch).length === 0) return { data: {} as SubjectRow, error: null };

  if (table === "inventory_items") {
    let query = client.from(table).update(patch as never)
      .eq("id", id).eq("restaurant_id", restaurantId);
    for (const [field, value] of Object.entries(expected)) {
      query = value === null
        ? query.is(field as keyof InventoryRow & string, null)
        : typeof value === "object"
          ? query.filter(field, "eq", JSON.stringify(value))
          : query.eq(field as keyof InventoryRow & string, value as never);
    }
    const { data, error } = await query.select("*").maybeSingle();
    return { data, error };
  }
  if (table === "invoice_scans") {
    let query = client.from(table).update(patch as never)
      .eq("id", id).eq("restaurant_id", restaurantId);
    for (const [field, value] of Object.entries(expected)) {
      query = value === null
        ? query.is(field as keyof ScanRow & string, null)
        : typeof value === "object"
          ? query.filter(field, "eq", JSON.stringify(value))
          : query.eq(field as keyof ScanRow & string, value as never);
    }
    const { data, error } = await query.select("*").maybeSingle();
    return { data, error };
  }
  let query = client.from(table).update(patch as never)
    .eq("id", id).eq("restaurant_id", restaurantId);
  for (const [field, value] of Object.entries(expected)) {
    query = value === null
      ? query.is(field as keyof WineRow & string, null)
      : typeof value === "object"
        ? query.filter(field, "eq", JSON.stringify(value))
        : query.eq(field as keyof WineRow & string, value as never);
  }
  const { data, error } = await query.select("*").maybeSingle();
  return { data, error };
}

async function resolvedPatch(
  client: Client,
  restaurantId: string,
  action: LedgerAction,
  prior: SubjectRow,
): Promise<Snapshot> {
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
    return { lineage_id: lineageId };
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

    const wineId = action.patch.wine_id as string;
    const wine = await readSubject(client, restaurantId, "wines", wineId) as WineRow | null;
    if (!wine) throw new LedgerFailure("Wine not found.", "not_found");
    const suggestion = suggestWineMatch(
      wineMatchIdentityFromLine(line as Record<string, unknown>),
      [{
        wineId: wine.id,
        title: `${wine.producer} ${wine.name}`,
        lwin: wine.lwin_id,
        producer: wine.producer,
        cuvee: wine.name,
        vintage: wine.vintage,
        format: wine.size_ml,
      }],
    );
    if (suggestion?.wineId !== wineId) {
      throw new LedgerFailure(
        "Proposed wine does not match the current scan identity.",
        "identity_mismatch",
        { wine_id: wineId, line_index: lineIndex },
      );
    }
    return {
      final_line_items: lines.map((item, index) => index === lineIndex
        ? { ...line, wine_id: wineId }
        : item),
    };
  }
  return {};
}

async function createBatch(
  client: Client,
  restaurantId: string,
  userId: string,
) {
  const { data, error } = await client.from("reconcile_batches").insert({
    restaurant_id: restaurantId,
    created_by: userId,
    action_count: 0,
  }).select("*").single();
  if (error || !data) throw new LedgerFailure("Batch creation failed.", "internal");
  return data;
}

async function updateBatchCount(
  client: Client,
  restaurantId: string,
  batchId: string,
  actionCount: number,
) {
  const { data, error } = await client.from("reconcile_batches")
    .update({ action_count: actionCount })
    .eq("id", batchId).eq("restaurant_id", restaurantId)
    .select("*").maybeSingle();
  if (error || !data) throw new LedgerFailure("Batch action count update failed.", "internal");
  return data;
}

async function createAction(
  client: Client,
  restaurantId: string,
  batchId: string,
  action: LedgerAction,
  priorState: Snapshot,
  newState: Snapshot,
  ordinal: number,
) {
  const { data, error } = await client.from("reconcile_actions").insert({
    batch_id: batchId,
    restaurant_id: restaurantId,
    action_type: action.action_type,
    subject_table: action.subject_table,
    subject_id: action.subject_id,
    prior_state: safeJson(priorState),
    new_state: safeJson(newState),
    ordinal,
  }).select("*").single();
  if (error || !data) throw new LedgerFailure("Action creation failed.", "internal");
  return data;
}

async function acceptCompensation(
  client: Client,
  restaurantId: string,
  action: LedgerAction,
  priorState: Snapshot,
  newState: Snapshot,
) {
  const result = await updateSubject(
    client,
    restaurantId,
    action.subject_table,
    action.subject_id,
    priorState,
    newState,
  );
  if (!result.error && result.data) return null;
  try {
    const current = await readSubject(
      client,
      restaurantId,
      action.subject_table,
      action.subject_id,
    );
    if (current && !matchesSnapshot(current, newState)) return null;
  } catch {
    // Report the original compensation failure below.
  }
  return {
    subject_table: action.subject_table,
    subject_id: action.subject_id,
  };
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

  const batch = await createBatch(client, restaurantId, userId);
  const actions: ActionRow[] = [];
  const applied: ReturnType<typeof actionDetails>[] = [];

  for (const [ordinal, action] of requested.entries()) {
    let priorState: Snapshot | null = null;
    let newState: Snapshot | null = null;
    let updateAttempted = false;
    try {
      const prior = await readSubject(
        client,
        restaurantId,
        action.subject_table,
        action.subject_id,
      );
      if (!prior) throw new LedgerFailure("Subject not found.", "not_found");
      const patch = await resolvedPatch(client, restaurantId, action, prior);
      priorState = projectedState(prior, patch);
      newState = { ...priorState, ...patch };
      const recorded = await createAction(
        client,
        restaurantId,
        batch.id,
        action,
        priorState,
        newState,
        ordinal,
      );

      if (action.action_type !== "dismiss") {
        updateAttempted = true;
        const expected = action.action_type === "place_bin"
          ? { bin_id: null }
          : priorState;
        const result = await updateSubject(
          client,
          restaurantId,
          action.subject_table,
          action.subject_id,
          patch,
          expected,
        );
        if (result.error) {
          throw new LedgerFailure("Subject update failed.", "internal");
        }
        if (!result.data) {
          throw new LedgerFailure("Subject changed during reconciliation.", "conflict");
        }
      }
      actions.push(recorded);
      applied.push(actionDetails(action, ordinal));
    } catch (caught) {
      const failure = caught instanceof LedgerFailure
        ? caught
        : new LedgerFailure("Reconciliation failed.", "internal");
      const compensationFailure = updateAttempted && priorState && newState
        ? await acceptCompensation(client, restaurantId, action, priorState, newState)
        : null;
      const progress = {
        ...detailsRecord(failure.details),
        batch_id: batch.id,
        applied,
        failed: actionDetails(action, ordinal),
        ...(compensationFailure ? { compensation_failures: [compensationFailure] } : {}),
      };
      try {
        await updateBatchCount(client, restaurantId, batch.id, applied.length);
      } catch (finalizeError) {
        throw new LedgerFailure(
          finalizeError instanceof Error ? finalizeError.message : "Batch action count update failed.",
          "internal",
          progress,
        );
      }
      if (compensationFailure) {
        throw new LedgerFailure("Accept compensation failed.", "internal", progress);
      }
      throw new LedgerFailure(failure.message, failure.kind, progress);
    }
  }

  try {
    const closed = await updateBatchCount(client, restaurantId, batch.id, applied.length);
    return { batch: closed, actions };
  } catch (error) {
    throw new LedgerFailure(
      error instanceof Error ? error.message : "Batch action count update failed.",
      "internal",
      { batch_id: batch.id, applied },
    );
  }
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
  const { data, error: actionsError } = await client
    .from("reconcile_actions").select("*").eq("batch_id", batchId)
    .eq("restaurant_id", restaurantId).order("ordinal", { ascending: false });
  if (actionsError) throw new LedgerFailure("Actions read failed.", "internal");
  return {
    batch,
    actions: data.filter((action) => action.ordinal < batch.action_count),
  };
}

async function compensateUndo(
  client: Client,
  restaurantId: string,
  restored: ActionRow[],
) {
  const failures = [];
  for (const action of [...restored].reverse()) {
    const table = action.subject_table as SubjectTable;
    const priorState = stateObject(action.prior_state);
    const newState = stateObject(action.new_state);
    const result = await updateSubject(
      client,
      restaurantId,
      table,
      action.subject_id,
      newState,
      priorState,
    );
    if (!result.error && result.data) continue;
    try {
      const current = await readSubject(client, restaurantId, table, action.subject_id);
      if (current && matchesSnapshot(current, newState)) continue;
    } catch {
      // Record the failed compensation below.
    }
    failures.push({ subject_table: table, subject_id: action.subject_id });
  }
  return failures;
}

async function compensateBatchClose(
  client: Client,
  restaurantId: string,
  batchId: string,
  userId: string,
  undoneAt: string,
) {
  const { data, error } = await client.from("reconcile_batches")
    .update({ undone_at: null, undone_by: null })
    .eq("id", batchId).eq("restaurant_id", restaurantId)
    .eq("undone_at", undoneAt).eq("undone_by", userId)
    .select("*").maybeSingle();
  if (!error && data) return null;
  const { data: current, error: readError } = await client.from("reconcile_batches")
    .select("undone_at").eq("id", batchId).eq("restaurant_id", restaurantId)
    .maybeSingle();
  return !readError && current?.undone_at === null
    ? null
    : { batch_id: batchId };
}

export async function undoBatch(
  client: Client,
  restaurantId: string,
  userId: string,
  batchId: string,
) {
  const { batch, actions } = await loadUndo(client, restaurantId, batchId);
  const expected = new Map<string, Snapshot>();
  const conflicts = [];
  for (const action of actions) {
    const table = action.subject_table as SubjectTable;
    const key = `${table}:${action.subject_id}`;
    const current = expected.get(key)
      ?? await readSubject(client, restaurantId, table, action.subject_id);
    const newState = stateObject(action.new_state);
    if (!current || !matchesSnapshot(current, newState)) {
      conflicts.push({ subject_table: table, subject_id: action.subject_id });
    } else {
      expected.set(key, stateObject(action.prior_state));
    }
  }
  if (conflicts.length) {
    throw new LedgerFailure("Subjects changed since reconciliation.", "conflict", { conflicts });
  }

  const restored: ActionRow[] = [];
  for (const action of actions) {
    const table = action.subject_table as SubjectTable;
    const priorState = stateObject(action.prior_state);
    const newState = stateObject(action.new_state);
    const result = await updateSubject(
      client,
      restaurantId,
      table,
      action.subject_id,
      priorState,
      newState,
    );
    if (!result.error && result.data) {
      restored.push(action);
      continue;
    }

    const compensationFailures = await compensateUndo(
      client,
      restaurantId,
      result.error ? [...restored, action] : restored,
    );
    const item = { subject_table: table, subject_id: action.subject_id };
    const details = {
      restored: restored.map(recordedActionDetails),
      ...(result.error ? { failed: item } : { conflicts: [item] }),
      ...(compensationFailures.length ? { compensation_failures: compensationFailures } : {}),
    };
    if (result.error || compensationFailures.length) {
      throw new LedgerFailure("Undo restoration failed.", "internal", details);
    }
    throw new LedgerFailure("Subject changed during undo.", "conflict", details);
  }

  const undoneAt = new Date().toISOString();
  const { data: closed, error } = await client.from("reconcile_batches")
    .update({ undone_at: undoneAt, undone_by: userId })
    .eq("id", batch.id).eq("restaurant_id", restaurantId)
    .is("undone_at", null).select("*").maybeSingle();
  if (error || !closed) {
    const compensationFailures = await compensateUndo(client, restaurantId, restored);
    const batchCompensationFailure = await compensateBatchClose(
      client,
      restaurantId,
      batch.id,
      userId,
      undoneAt,
    );
    throw new LedgerFailure("Batch close failed.", "internal", {
      restored: restored.map(recordedActionDetails),
      ...(compensationFailures.length ? { compensation_failures: compensationFailures } : {}),
      ...(batchCompensationFailure
        ? { batch_compensation_failure: batchCompensationFailure }
        : {}),
    });
  }
  return closed;
}
