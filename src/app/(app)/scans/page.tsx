import type { Metadata } from "next";
import Link from "next/link";
import { getAuthContext } from "@/lib/auth-context";
import { ArrowLeft, ChevronLeft, ChevronRight, FileText, ScanLine } from "lucide-react";
import { RouteDataEmpty } from "@/components/route-data-state";
import { describeScanStatusReason } from "@/lib/scanner/scan-status-reason";
import { ExportCsvButton } from "./export-csv-button";
import { ScanStatusSelect } from "./scan-status-select";
import {
  buildQuery,
  parseStatus,
  statusBadge,
  statusLabel,
  type StatusFilter,
} from "./scan-list-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Scan History" };

const PAGE_SIZE = 20;

type ScanRow = {
  id: string;
  distributor_name: string;
  invoice_number: string | null;
  invoice_date: string | null;
  status: string;
  item_count: number;
  accuracy_score: number | null;
  status_reason: string | null;
  created_at: string;
};

type SearchParams = Promise<{ page?: string; status?: string }>;

export default async function ScansPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const status = parseStatus(sp.status);

  const auth = await getAuthContext();
  if (!auth) return null;
  const { supabase, restaurantId } = auth;

  let query = supabase
    .from("invoice_scans")
    .select(
      "id, distributor_name, invoice_number, invoice_date, status, item_count, accuracy_score, status_reason, created_at",
      { count: "exact" },
    )
    .eq("restaurant_id", restaurantId);

  if (status !== "all") {
    query = query.eq("status", status);
  }

  const statusCountQuery = (s: Exclude<StatusFilter, "all">) =>
    supabase
      .from("invoice_scans")
      .select("id", { count: "exact", head: true })
      .eq("restaurant_id", restaurantId)
      .eq("status", s);

  const [scansRes, completeRes, processingRes, reviewRes, failedRes] = await Promise.all([
    query.order("created_at", { ascending: false }).range(offset, offset + PAGE_SIZE - 1),
    statusCountQuery("complete"),
    statusCountQuery("processing"),
    statusCountQuery("review"),
    statusCountQuery("failed"),
  ]);
  const { data: scans, error, count } = scansRes;

  const statusCounts: Record<Exclude<StatusFilter, "all">, number> = {
    complete: completeRes.count ?? 0,
    processing: processingRes.count ?? 0,
    review: reviewRes.count ?? 0,
    failed: failedRes.count ?? 0,
  };

  if (error) {
    console.error("Failed to load scan history:", error);
    return (
      <div className="flex flex-col items-center justify-center py-24">
        <p className="text-[14px] text-grey">Failed to load scan history.</p>
      </div>
    );
  }

  const total = count ?? scans.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rows: ScanRow[] = scans;
  const hasMore = page < totalPages;

  const statusFilter = (
    <ScanStatusSelect status={status} counts={statusCounts} />
  );

  const headerBlock = (
    <header className="mb-lg">
      <Link
        href="/scan"
        className="mb-md inline-flex min-h-11 items-center gap-xs text-[13px] text-grey hover:text-ink focus-ring"
      >
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2} />
        Back to scanner
      </Link>
      <div className="flex items-center justify-between gap-md">
        <h1 className="font-serif text-heading-sm text-ink md:text-heading">Scan history</h1>
        <div className="flex items-center gap-sm">
          {rows.length > 0 && (
            <span className="rounded-pill bg-wash px-sm py-xs text-[11px] font-medium uppercase tracking-[0.1em] text-grey">
              {offset + 1}–{offset + rows.length} of {total}
            </span>
          )}
          <ExportCsvButton rows={rows} />
        </div>
      </div>
      {statusFilter}
    </header>
  );

  if (rows.length === 0 && page === 1) {
    const emptyCopy =
      status === "processing"
        ? {
            title: "No scans in progress",
            body: "Nothing is being extracted right now. Photograph an invoice to start a new scan.",
          }
        : status === "complete"
          ? {
              title: "No completed scans yet",
              body: "Scans show up here once OCR finishes successfully.",
            }
          : status === "failed"
            ? {
                title: "No failed scans",
                body: "Nice — every scan has extracted cleanly.",
              }
            : status === "review"
              ? {
                  title: "Nothing needs a second look",
                  body: "Nice — no scan has numbers that don't add up right now.",
                }
              : {
                  title: "No scans yet",
                  body: "Photograph an invoice to start building your inventory.",
                };

    return (
      <section>
        {headerBlock}
        <RouteDataEmpty
          icon={<ScanLine className="h-6 w-6" strokeWidth={1.5} />}
          title={emptyCopy.title}
          description={emptyCopy.body}
          action={
            <Link
              href="/scan"
              className="inline-flex h-11 items-center gap-sm rounded-pill bg-primary px-md text-[14px] font-medium text-seal-ink hover:bg-primary-hover focus-ring"
            >
              Scan an invoice
            </Link>
          }
        />
      </section>
    );
  }

  return (
    <section>
      {headerBlock}

      {/* Desktop table */}
      <div className="hidden overflow-hidden rounded-card card-surface md:block">
        <table className="w-full border-collapse text-[14px]">
          <thead>
            <tr className="bg-wash">
              <th scope="col" className="px-md py-sm text-left text-caption font-medium uppercase tracking-[0.18em] text-grey">
                Date
              </th>
              <th scope="col" className="px-md py-sm text-left text-caption font-medium uppercase tracking-[0.18em] text-grey">
                Supplier
              </th>
              <th scope="col" className="px-md py-sm text-left text-caption font-medium uppercase tracking-[0.18em] text-grey">
                Invoice #
              </th>
              <th scope="col" className="px-md py-sm text-center text-caption font-medium uppercase tracking-[0.18em] text-grey">
                Items
              </th>
              <th scope="col" className="px-md py-sm text-center text-caption font-medium uppercase tracking-[0.18em] text-grey">
                Status
              </th>
              <th scope="col" className="px-md py-sm text-center text-caption font-medium uppercase tracking-[0.18em] text-grey">
                Accuracy
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s, i) => (
              <tr
                key={s.id}
                className={`border-t border-rule hover:bg-wash ${
                  i === 0 ? "border-t-0" : ""
                }`}
              >
                <td className="px-md py-sm">
                  <Link
                    href={`/scan/${s.id}`}
                    className="block text-ink hover:text-accent focus-ring"
                  >
                    <span className="font-mono text-[13px] tabular">
                      {s.invoice_date ?? s.created_at.slice(0, 10)}
                    </span>
                  </Link>
                </td>
                <td className="px-md py-sm">
                  <Link
                    href={`/scan/${s.id}`}
                    className="block font-medium text-ink hover:text-accent focus-ring"
                  >
                    {s.distributor_name}
                  </Link>
                  {/* D6 rule 1: nothing vanishes on its own, so a row that
                      found nothing or failed has to say WHY here — a 0-item
                      "complete" and a 0-item "failed" were otherwise
                      indistinguishable. */}
                  {describeScanStatusReason(s.status_reason) && (
                    <p className="mt-2xs text-ledger text-grey">
                      {describeScanStatusReason(s.status_reason)}
                    </p>
                  )}
                </td>
                <td className="px-md py-sm">
                  <Link
                    href={`/scan/${s.id}`}
                    className="block font-mono text-[13px] text-grey focus-ring"
                  >
                    {s.invoice_number ?? "—"}
                  </Link>
                </td>
                <td className="px-md py-sm text-center">
                  <Link
                    href={`/scan/${s.id}`}
                    className="block font-mono tabular text-ink focus-ring"
                  >
                    {s.item_count}
                  </Link>
                </td>
                <td className="px-md py-sm text-center">
                  <Link href={`/scan/${s.id}`} className="block focus-ring">
                    <span
                      className={`inline-block rounded-pill px-sm py-2xs text-[10.5px] font-medium uppercase tracking-wide ${statusBadge(s.status)}`}
                    >
                      {statusLabel(s.status)}
                    </span>
                  </Link>
                </td>
                <td className="px-md py-sm text-center">
                  <Link href={`/scan/${s.id}`} className="block focus-ring">
                    <span className="font-mono text-[13px] text-grey tabular">
                      {s.accuracy_score != null
                        ? `${Math.round(s.accuracy_score * 100)}%`
                        : "—"}
                    </span>
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="flex flex-col gap-sm md:hidden">
        {rows.map((s) => (
          <Link
            key={s.id}
            href={`/scan/${s.id}`}
            className="flex items-center gap-md rounded-card card-surface p-md hover:bg-wash focus-ring"
          >
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-pill bg-wash">
              <FileText className="h-5 w-5 text-grey" strokeWidth={1.5} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14px] font-medium text-ink">
                {s.distributor_name}
              </div>
              <div className="mt-2xs flex items-center gap-sm text-[12px] text-grey">
                <span className="font-mono">
                  {s.invoice_date ?? s.created_at.slice(0, 10)}
                </span>
                {s.invoice_number && (
                  <>
                    <span aria-hidden className="text-grey">·</span>
                    <span className="font-mono">#{s.invoice_number}</span>
                  </>
                )}
              </div>
              {describeScanStatusReason(s.status_reason) && (
                <p className="mt-2xs text-ledger text-grey">
                  {describeScanStatusReason(s.status_reason)}
                </p>
              )}
            </div>
            <div className="flex shrink-0 flex-col items-end gap-xs">
              <span className="font-mono text-[14px] tabular text-ink">
                {s.item_count}
              </span>
              <span
                className={`inline-block rounded-pill px-sm py-2xs text-[10px] font-medium uppercase tracking-wide ${statusBadge(s.status)}`}
              >
                {statusLabel(s.status)}
              </span>
            </div>
          </Link>
        ))}
      </div>

      {/* Pagination */}
      <nav
        aria-label="Scan history pagination"
        className="mt-lg flex items-center justify-center gap-sm"
      >
        {page > 1 ? (
          <Link
            href={`/scans${buildQuery({ page: page - 1, status })}`}
            className="inline-flex min-h-11 items-center gap-xs rounded-pill border border-edge bg-surface px-md text-[13px] font-medium text-ink hover:bg-wash focus-ring"
          >
            <ChevronLeft className="h-4 w-4" strokeWidth={2} />
            Previous
          </Link>
        ) : (
          <span className="inline-flex min-h-11 items-center gap-xs rounded-pill border border-rule bg-surface px-md text-[13px] font-medium text-grey opacity-50">
            <ChevronLeft className="h-4 w-4" strokeWidth={2} />
            Previous
          </span>
        )}
        <span className="px-sm text-[13px] tabular text-grey">
          Page {page} of {totalPages}
        </span>
        {hasMore ? (
          <Link
            href={`/scans${buildQuery({ page: page + 1, status })}`}
            className="inline-flex min-h-11 items-center gap-xs rounded-pill border border-edge bg-surface px-md text-[13px] font-medium text-ink hover:bg-wash focus-ring"
          >
            Next
            <ChevronRight className="h-4 w-4" strokeWidth={2} />
          </Link>
        ) : (
          <span className="inline-flex min-h-11 items-center gap-xs rounded-pill border border-rule bg-surface px-md text-[13px] font-medium text-grey opacity-50">
            Next
            <ChevronRight className="h-4 w-4" strokeWidth={2} />
          </span>
        )}
      </nav>
    </section>
  );
}
