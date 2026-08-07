import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function tableKey(entry) {
  return `${entry.schema}.${entry.table}`;
}

function sequenceKey(entry) {
  return `${entry.schema}.${entry.sequence}`;
}

export function compareDatabaseEvidence(source, restored) {
  const failures = [];
  if (source.format_version !== 1 || restored.format_version !== 1) {
    failures.push("unsupported evidence format");
  }
  if (source.migration_version !== restored.migration_version) {
    failures.push(
      `migration version differs (${String(source.migration_version)} != ${String(restored.migration_version)})`,
    );
  }

  const sourceTables = new Map(
    source.tables.map((entry) => [tableKey(entry), entry]),
  );
  const restoredTables = new Map(
    restored.tables.map((entry) => [tableKey(entry), entry]),
  );
  const targetOnlyTables = [...restoredTables.keys()]
    .filter((table) => !sourceTables.has(table))
    .sort();
  for (const table of [...sourceTables.keys()].sort()) {
    const sourceTable = sourceTables.get(table);
    const restoredTable = restoredTables.get(table);
    if (!restoredTable) {
      failures.push(`source table missing after restore for ${table}`);
    } else if (sourceTable.row_count !== restoredTable.row_count) {
      failures.push(
        `row count differs for ${table} (${sourceTable.row_count} != ${restoredTable.row_count})`,
      );
    } else if (
      sourceTable.kind !== undefined &&
      sourceTable.kind !== restoredTable.kind
    ) {
      failures.push(`relation kind differs for ${table}`);
    }
  }

  const restoredChecksums = new Map(
    restored.largest_non_empty_tables.map((entry) => [
      tableKey(entry),
      entry.sha256,
    ]),
  );
  for (const entry of source.largest_non_empty_tables) {
    const table = tableKey(entry);
    if (restoredChecksums.get(table) !== entry.sha256) {
      failures.push(`content checksum differs for ${table}`);
    }
  }

  const sourceSequences = new Map(
    (source.sequences ?? []).map((entry) => [sequenceKey(entry), entry]),
  );
  const restoredSequences = new Map(
    (restored.sequences ?? []).map((entry) => [sequenceKey(entry), entry]),
  );
  const targetOnlySequences = [...restoredSequences.keys()]
    .filter((sequence) => !sourceSequences.has(sequence))
    .sort();
  for (const sequence of [...sourceSequences.keys()].sort()) {
    const sourceState = sourceSequences.get(sequence);
    const restoredState = restoredSequences.get(sequence);
    if (!restoredState) {
      failures.push(`source sequence missing after restore for ${sequence}`);
    } else if (
      sourceState.last_value !== restoredState.last_value ||
      sourceState.is_called !== restoredState.is_called
    ) {
      failures.push(`sequence state differs for ${sequence}`);
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    migration_version: restored.migration_version,
    table_count: restored.tables.length,
    sequence_count: restoredSequences.size,
    checked_content_checksums:
      source.largest_non_empty_tables.length,
    tables: restored.tables,
    sequences: restored.sequences ?? [],
    target_only_tables: targetOnlyTables,
    target_only_sequences: targetOnlySequences,
    content_checksums: restored.largest_non_empty_tables,
  };
}

function main() {
  const sourceFile = process.env.BACKUP_SOURCE_EVIDENCE_FILE;
  const restoredFile = process.env.BACKUP_RESTORED_EVIDENCE_FILE;
  const reportFile = process.env.BACKUP_RESTORE_REPORT_FILE;
  if (!sourceFile || !restoredFile || !reportFile) {
    throw new Error(
      "BACKUP_SOURCE_EVIDENCE_FILE, BACKUP_RESTORED_EVIDENCE_FILE, and BACKUP_RESTORE_REPORT_FILE are required.",
    );
  }
  const result = compareDatabaseEvidence(
    JSON.parse(readFileSync(sourceFile, "utf8")),
    JSON.parse(readFileSync(restoredFile, "utf8")),
  );
  const report = {
    format_version: 1,
    verified_at: new Date().toISOString(),
    ...result,
  };
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (!result.ok) {
    throw new Error(
      `Restore evidence comparison failed: ${result.failures.join("; ")}`,
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
