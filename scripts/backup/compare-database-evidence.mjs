import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function tableKey(entry) {
  return `${entry.schema}.${entry.table}`;
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

  const sourceCounts = new Map(
    source.tables.map((entry) => [tableKey(entry), entry.row_count]),
  );
  const restoredCounts = new Map(
    restored.tables.map((entry) => [tableKey(entry), entry.row_count]),
  );
  const allTables = [...new Set([
    ...sourceCounts.keys(),
    ...restoredCounts.keys(),
  ])].sort();
  for (const table of allTables) {
    if (!sourceCounts.has(table) || !restoredCounts.has(table)) {
      failures.push(`table inventory differs for ${table}`);
    } else if (sourceCounts.get(table) !== restoredCounts.get(table)) {
      failures.push(
        `row count differs for ${table} (${sourceCounts.get(table)} != ${restoredCounts.get(table)})`,
      );
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

  return {
    ok: failures.length === 0,
    failures,
    migration_version: restored.migration_version,
    table_count: restored.tables.length,
    checked_content_checksums:
      source.largest_non_empty_tables.length,
    tables: restored.tables,
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
