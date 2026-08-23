#!/usr/bin/env bash
# P1 — one-command bulk-import test scaffold.
#
# No arg:   generates the deterministic 20,000-row partner-cellar fixture
#           (idempotent — same seed, same bytes every time) and runs the P1
#           validation below against it.
# With arg: runs the same validation against an arbitrary CSV (the real
#           partner file, once it arrives). Ground-truth-manifest assertions
#           that don't apply to a file with no manifest are skipped
#           automatically.
#
# "Validation" today = parse + validate with the repo's OWN csv-parser and
# row-validator (src/domains/import/*) and report rows parsed / valid /
# invalid / distinct raw variant keys / wall-clock ms. This is deliberately
# the whole contract for now — later pieces (import apply, LWIN/enrichment
# matching) extend this SAME entry point rather than adding a new one.
#
# No DB, no network, no dev server required.

set -euo pipefail
cd "$(dirname "$0")/.."

CSV_PATH="${1:-}"

if [ -z "$CSV_PATH" ]; then
  echo "=== Generating deterministic 20k partner-cellar fixture ==="
  node scripts/fixtures/generate-partner-cellar.mjs
  echo ""
  CSV_PATH="fixtures/generated/partner-cellar-20k.csv"
fi

npx tsx scripts/validate-bulk-import.ts "$CSV_PATH"
