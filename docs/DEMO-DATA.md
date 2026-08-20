# Historical demo data

## Status

This file records a production demo-data load reported on 2026-04-24. The
current rows, memberships, counts, and public slugs have not been verified in
this documentation sweep. Treat every value below as historical evidence, not
as a current fixture contract or authorization to query, change, or delete
production data.

The original document included a named person's email address, production
project identifiers, record identifiers, and executable teardown SQL. Those
details are not required to understand the historical dataset and have been
removed.

## Historical contents

The load report recorded:

- one restaurant with auto-86 enabled;
- 40 wines across Old World and New World regions, varied price tiers, five
  colors, and several bottle formats;
- 40 inventory rows with legacy bin locations;
- 11 open bottles and 30 pour events across two weeks;
- two published wine lists, one by-the-glass and one full list;
- one manual availability event; and
- one owner membership added for access to the demo restaurant.

The historical generation process used deterministic identifiers so related
rows could be recognized. This document intentionally omits those identifiers.

## Current route guidance

After a live read-only membership check confirms that the demo restaurant still
exists and the operator is authorized to view it, use the current application
routes:

- `/lists` for wine lists;
- `/cellar` for availability, inventory, and pour actions;
- `/cellar/open` for open bottles;
- `/cellar/reconcile` for the legacy end-of-shift bottle reconcile flow;
- `/reconcile-queue` for the newer ranked data-quality queue;
- `/bins` for first-class cellar locations; and
- `/insights` for cellar, yield, staff, and pricing analytics.

The old `/wine-list`, `/availability`, `/pour`, and `/reconcile` UI routes are
not current App Router pages. Public list URLs may still use `/list/[slug]`, but
the historical slugs in the original report must be verified before use.

## Production safety

Do not run a delete statement from documentation. Production teardown requires
all of the following in the same authorized session:

1. A read-only query confirms the exact restaurant and every affected child
   table using current schema names.
2. The operator records current row counts and verifies that no live customer,
   user, list, Auth, Storage, or integration data shares the target scope.
3. The latest backup and disposable restore drill are healthy.
4. The user gives explicit approval for the exact production target and
   deletion plan after reviewing the evidence.
5. The operator uses the approved production runbook and records the result.

Foreign-key cascades can remove related inventory, bottle, event, list,
reconciliation, and analytics records. A historical identifier prefix is not
sufficient proof of ownership or deletion scope.

## Historical counts

At load time, the report expected 40 wines, two lists, 40 inventory rows,
11 open bottles, and 30 pour events. Do not use those counts as a health check
without a new read-only production query and dated evidence.
