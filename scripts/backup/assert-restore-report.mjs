import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function assertRestoreReport(source, report) {
  if (
    source?.format_version !== 1 ||
    !Array.isArray(source.tables) ||
    !Array.isArray(source.largest_non_empty_tables)
  ) {
    throw new Error("Source evidence has an unsupported checksum inventory.");
  }
  if (
    report?.format_version !== 1 ||
    report.ok !== true ||
    !Array.isArray(report.failures) ||
    report.failures.length !== 0 ||
    !Array.isArray(report.content_checksums)
  ) {
    throw new Error("Restore report does not record a successful comparison.");
  }

  const required = Math.min(
    10,
    source.tables.filter(({ row_count }) => row_count > 0).length,
  );
  if (source.largest_non_empty_tables.length !== required) {
    throw new Error(
      `Source evidence contains ${source.largest_non_empty_tables.length} of ${required} required content checksums.`,
    );
  }
  if (
    report.required_content_checksums !== undefined &&
    report.required_content_checksums !== required
  ) {
    throw new Error("Restore report records an incorrect checksum requirement.");
  }
  if (
    report.checked_content_checksums !== required ||
    report.content_checksums.length !== required
  ) {
    throw new Error(
      `Restore report must contain all required ${required} content checksums.`,
    );
  }
}

function main() {
  const sourceFile = process.env.BACKUP_SOURCE_EVIDENCE_FILE;
  const reportFile = process.env.BACKUP_RESTORE_REPORT_FILE;
  if (!sourceFile || !reportFile) {
    throw new Error(
      "BACKUP_SOURCE_EVIDENCE_FILE and BACKUP_RESTORE_REPORT_FILE are required.",
    );
  }
  assertRestoreReport(
    JSON.parse(readFileSync(sourceFile, "utf8")),
    JSON.parse(readFileSync(reportFile, "utf8")),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
