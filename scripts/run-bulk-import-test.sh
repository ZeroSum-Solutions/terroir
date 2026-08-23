#!/usr/bin/env bash
# P1 — one-command bulk-import test scaffold.
#
# No arg:   generates the deterministic 20,000-row partner-cellar fixture
#           (idempotent — same seed, same bytes every time) PLUS its
#           --extras variant (barcode/supplier/acquisition_date/
#           purchase_price columns) AND its --dirty variant (50 tagged
#           expected-invalid rows appended — bad_vintage_text,
#           negative_quantity, oversized_field), and runs the P1 validation
#           below against all three — this is what exercises the
#           barcode/EAN-13 path AND the poisoned-chunk isolation path
#           (a real dirty export's oversized field failing a whole
#           MAX_ROWS-sized parseCsv() chunk, isolated back down to the one
#           poisoned record) end to end in the default flow, not just when
#           --extras/--dirty are passed by hand.
# With arg: runs the same validation against an arbitrary CSV (the real
#           partner file, once it arrives). Ground-truth-manifest assertions
#           that don't apply to a file with no manifest are skipped
#           automatically.
#
# "Validation" today = parse + validate with the repo's OWN csv-parser and
# row-validator (src/domains/import/*) and report rows parsed / valid /
# invalid / distinct raw variant keys / wall-clock ms, plus (see
# validate-bulk-import.ts) manifest-tagged expected-invalid groups, EAN-13
# barcode verification, and a sha256 integrity check. This is deliberately
# the whole contract for now — later pieces (import apply, LWIN/enrichment
# matching) extend this SAME entry point rather than adding a new one.
#
# validate-bulk-import.ts exits non-zero on any real anomaly (see its module
# doc), and `set -e` below means this script exits non-zero the moment
# either sub-run does.
#
# No DB, no network, no dev server required.

set -euo pipefail
cd "$(dirname "$0")/.."

CSV_PATH="${1:-}"

if [ -z "$CSV_PATH" ]; then
  echo "=== Generating deterministic 20k partner-cellar fixture (base + --extras + --dirty) ==="
  node scripts/fixtures/generate-partner-cellar.mjs
  node scripts/fixtures/generate-partner-cellar.mjs --extras
  # --dirty writes the same "partner-cellar-20k.csv" filename slot as the
  # clean base fixture (dirty is a variant of the base file, not a new
  # column set like --extras) — give it its own --out-dir so it doesn't
  # clobber the clean fixture validated just above.
  node scripts/fixtures/generate-partner-cellar.mjs --dirty --out-dir fixtures/generated/dirty
  echo ""
  npx tsx scripts/validate-bulk-import.ts "fixtures/generated/partner-cellar-20k.csv"
  echo ""
  npx tsx scripts/validate-bulk-import.ts "fixtures/generated/partner-cellar-20k-extras.csv"
  echo ""
  npx tsx scripts/validate-bulk-import.ts "fixtures/generated/dirty/partner-cellar-20k.csv"
  echo ""
  echo "=== run-bulk-import-test: PASS (base + extras + dirty) ==="
else
  npx tsx scripts/validate-bulk-import.ts "$CSV_PATH"
fi
