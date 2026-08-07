import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/u;
const TABLE_DATA = /^(\d+;\s+\d+\s+\d+\s+)TABLE DATA ([A-Za-z_][A-Za-z0-9_$]*) ([A-Za-z_][A-Za-z0-9_$]*) (\S+)\s*$/u;
const SEQUENCE_SET = /^(\d+;\s+\d+\s+\d+\s+)SEQUENCE SET ([A-Za-z_][A-Za-z0-9_$]*) ([A-Za-z_][A-Za-z0-9_$]*) (\S+)\s*$/u;

function inventoryKey(schema, name) {
  if (!IDENTIFIER.test(schema) || !IDENTIFIER.test(name)) {
    throw new Error("Restore inventory contains an unsupported identifier.");
  }
  return `${schema}.${name}`;
}

function evidenceInventory(evidence) {
  if (
    evidence?.format_version !== 1 ||
    !Array.isArray(evidence.tables) ||
    !Array.isArray(evidence.sequences)
  ) {
    throw new Error("Source evidence has an unsupported restore inventory.");
  }
  const tables = new Set();
  const requiredTables = new Set();
  for (const entry of evidence.tables) {
    const key = inventoryKey(entry.schema, entry.table);
    if (tables.has(key)) throw new Error(`Duplicate table evidence for ${key}.`);
    tables.add(key);
    if (entry.kind !== "partitioned") requiredTables.add(key);
  }
  const sequences = new Set();
  for (const entry of evidence.sequences) {
    const key = inventoryKey(entry.schema, entry.sequence);
    if (sequences.has(key)) {
      throw new Error(`Duplicate sequence evidence for ${key}.`);
    }
    sequences.add(key);
  }
  if (tables.size === 0) throw new Error("Restore table inventory is empty.");
  return { tables, requiredTables, sequences };
}

export function createRestoreUseList(listing, evidence) {
  const inventory = evidenceInventory(evidence);
  const selected = [];
  const observedTables = new Set();
  const observedSequences = new Set();

  for (const line of listing.split("\n")) {
    if (!line || line.startsWith(";")) continue;
    const tableMatch = line.match(TABLE_DATA);
    if (tableMatch) {
      const key = inventoryKey(tableMatch[2], tableMatch[3]);
      if (!inventory.tables.has(key)) continue;
      if (observedTables.has(key)) {
        throw new Error(`Archive contains duplicate TABLE DATA for ${key}.`);
      }
      observedTables.add(key);
      selected.push(line);
      continue;
    }
    const sequenceMatch = line.match(SEQUENCE_SET);
    if (sequenceMatch) {
      const key = inventoryKey(sequenceMatch[2], sequenceMatch[3]);
      if (!inventory.sequences.has(key)) continue;
      if (observedSequences.has(key)) {
        throw new Error(`Archive contains duplicate SEQUENCE SET for ${key}.`);
      }
      observedSequences.add(key);
      selected.push(line);
      continue;
    }
    if (/\s(?:TABLE DATA|SEQUENCE SET)\s/u.test(line)) {
      throw new Error("Archive contains an unparseable data entry.");
    }
    if (/\s(?:BLOB|BLOBS)(?:\s|$)/u.test(line)) {
      throw new Error(
        "Archive contains large-object data not covered by source evidence.",
      );
    }
  }

  for (const key of inventory.requiredTables) {
    if (!observedTables.has(key)) {
      throw new Error(`Archive is missing TABLE DATA for ${key}.`);
    }
  }
  for (const key of inventory.sequences) {
    if (!observedSequences.has(key)) {
      throw new Error(`Archive is missing SEQUENCE SET for ${key}.`);
    }
  }
  if (selected.length === 0) {
    throw new Error("Restore use-list selected no authenticated data entries.");
  }
  return `${selected.join("\n")}\n`;
}

export async function writeRestoreUseList({
  archiveListFile = process.env.BACKUP_ARCHIVE_LIST_FILE,
  evidenceFile = process.env.BACKUP_SOURCE_EVIDENCE_FILE,
  useListFile = process.env.BACKUP_RESTORE_USE_LIST_FILE,
} = {}) {
  if (!archiveListFile || !evidenceFile || !useListFile) {
    throw new Error(
      "BACKUP_ARCHIVE_LIST_FILE, BACKUP_SOURCE_EVIDENCE_FILE, and BACKUP_RESTORE_USE_LIST_FILE are required.",
    );
  }
  const [listing, evidence] = await Promise.all([
    readFile(archiveListFile, "utf8"),
    readFile(evidenceFile, "utf8").then(JSON.parse),
  ]);
  await writeFile(useListFile, createRestoreUseList(listing, evidence), {
    encoding: "utf8",
    mode: 0o600,
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await writeRestoreUseList();
}
