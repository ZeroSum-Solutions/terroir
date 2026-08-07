# UI control audit

The TER-006 audit makes visible interface promises machine-checkable. The
the [generated inventory](ui-control-inventory.json) covers every App Router
page plus every link, button, form, non-hidden input, select, and textarea under
the [application source tree](../src/app/). Each control records its source location, applicable roles, active
feature-ledger requirement, and interaction-test owner.

The [control policy](ui-control-policy.json) is the reviewed source of route and role coverage.
It is also the only place that maps source areas to active requirement IDs. Run
`pnpm run ui-controls:generate` after intentionally changing a route or control,
then review the generated diff. CI runs `pnpm run verify:ui-controls` and rejects
a stale inventory.

## Static gate

The verifier rejects:

- newly introduced placeholder promises such as "coming soon" or "not
  implemented";
- permanent `disabled` or `aria-disabled` controls without both a user-facing
  `data-ui-unavailable-reason` and a `data-ui-recovery-action`;
- `Link` and anchor elements with empty, fragment-only, or JavaScript URLs;
- forms without an action or submit handler; and
- explicit `type="button"` actions without a click handler or drag listener.

Pending requests and validation can still disable a control dynamically. A
genuinely unavailable control must explain what is unavailable and how this
user can recover; otherwise remove it until the owning feature is ready. The
The [mutation tests](../src/test/contracts/ui-control-audit.test.ts) seed each failure
class so weakening the detector fails the contract suite.

## Browser crawl

Run `pnpm run test:ui-crawl` only against local or isolated staging fixture data.
Set `UI_CRAWL_BASE_URL` to use an already running isolated deployment; otherwise
Playwright starts the local application. Authenticated roles use Playwright
storage-state files named by `UI_CRAWL_OWNER_STORAGE_STATE`,
`UI_CRAWL_MANAGER_STORAGE_STATE`, and `UI_CRAWL_STAFF_STORAGE_STATE`. The guest
crawl needs no authentication state. `UI_CRAWL_BROWSER_PATH` may point to an
already installed Chromium executable when the Playwright-managed binary is not
available on the runner.

Dynamic routes use fixture identifiers from `UI_CRAWL_INVITE_TOKEN`,
`UI_CRAWL_PUBLIC_LIST_SLUG`, `UI_CRAWL_WINE_LIST_ID`, and `UI_CRAWL_SCAN_ID`.
Set `UI_CRAWL_REQUIRE_ALL_ROLES=1` for release evidence: the crawler then fails
if any role state or dynamic-route sample is missing. Without that flag, missing
authenticated states and dynamic samples are reported in the attached JSON and
skipped so the ordinary local Playwright smoke suite stays usable.

For each covered route, the crawler records visible controls, rejects unlabeled
action controls and dead runtime URLs, follows every same-origin link in the
role's authenticated browser context, and fails on page errors or unexpected
client- or server-error HTTP responses. Playwright attaches a JSON crawl report to each
role test as the review artifact.

## Approval boundary

The current inventory contains no approved permanent unavailable states. Product
owner sign-off is still required before TER-006 can be called operationally
complete: run the all-role crawl against isolated fixtures, review its attached
reports, and approve any future unavailable-state record. Retiring a labeled
feature remains a feature-ledger decision, not a UI-audit exception.
