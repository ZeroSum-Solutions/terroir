import type { Metadata } from "next";
import Link from "next/link";
import { getAuthContext } from "@/lib/auth-context";
import { ArrowLeft, ChevronLeft, ChevronRight, FileText, ScanLine } from "lucide-react";
import { ExportCsvButton } from "./export-csv-button";

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
  created_at: string;
};

type StatusFilter = "all" | "complete" | "processing" | "failed";

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "complete", label: "Complete" },
  { value: "processing", label: "Processing" },
  { value: "failed", label: "Failed" },
];

function parseStatus(raw: string | undefined): StatusFilter {
  if (raw === "complete" || raw === "processing" || raw === "failed") return raw;
  return "all";
}

function buildQuery(params: { page?: number; status?: StatusFilter }) {
  const parts: string[] = [];
  if (params.page && params.page > 1) parts.push(`page=${params.page}`);
  if (params.status && params.status !== "all") parts.push(`status=${params.status}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

type SearchParams = Promise<{ page?: string; status?: string }>;

function statusLabel(status: string) {
  switch (status) {
    case "complete":
      return "Complete";
    case "processing":
      return "Processing";
    case "failed":
      return "Failed";
    default:
      return status.charAt(0).toUpperCase() + status.slice(1);
  }
}

function statusBadge(status: string) {
  switch (status) {
    case "complete":
      return "bg-success-soft text-success";
    case "processing":
      return "bg-warning-soft text-warning";
    case "failed":
      return "bg-danger-soft text-danger";
    default:
      return "bg-surface-muted text-ink-muted";
  }
}

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
      "id, distributor_name, invoice_number, invoice_date, status, item_count, accuracy_score, created_at",
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

  const [scansRes, completeRes, processingRes, failedRes] = await Promise.all([
    query.order("created_at", { ascending: false }).range(offset, offset + PAGE_SIZE - 1),
    statusCountQuery("complete"),
    statusCountQuery("processing"),
    statusCountQuery("failed"),
  ]);
  const { data: scans, error, count } = scansRes;

  const statusCounts: Record<Exclude<StatusFilter, "all">, number> = {
    complete: completeRes.count ?? 0,
    processing: processingRes.count ?? 0,
    failed: failedRes.count ?? 0,
  };

  if (error) {
    console.error("Failed to load scan history:", error);
    return (
      <div className="flex flex-col items-center justify-center py-24">
        <p className="text-[14px] text-ink-muted">Failed to load scan history.</p>
      </div>
    );
  }

  const total = count ?? scans.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rows: ScanRow[] = scans;
  const hasMore = page < totalPages;

  const filterChips = (
    <div
      role="radiogroup"
      aria-label="Filter scans by status"
      className="mt-md flex flex-wrap gap-xs"
    >
      {STATUS_FILTERS.map((f) => {
        const active = status === f.value;
        const countForChip =
          f.value === "all"
            ? statusCounts.complete + statusCounts.processing + statusCounts.failed
            : statusCounts[f.value];
        return (
          <Link
            key={f.value}
            href={`/scans${buildQuery({ status: f.value })}`}
            role="radio"
            aria-checked={active}
            aria-label={`${f.label} (${countForChip})`}
            className={`inline-flex h-8 items-center gap-xs rounded-pill border px-md text-[12px] font-medium transition-colors focus-visible:ring-2 focus-visible:ring-accent-soft focus-visible:ring-offset-2 ${
              active
                ? "border-ink bg-ink text-white"
                : "border-border-strong bg-white text-ink-muted hover:bg-surface-muted"
            }`}
          >
            <span>{f.label}</span>
            <span
              aria-hidden
              className={`tabular text-[11px] ${
                active ? "text-white/70" : "text-ink-subtle"
              }`}
            >
              {countForChip}
            </span>
          </Link>
        );
      })}
    </div>
  );

  const headerBlock = (
    <header className="mb-lg">
      <Link
        href="/scan"
        className="mb-md inline-flex items-center gap-xs text-[13px] text-ink-muted hover:text-ink"
      >
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2} />
        Back to scanner
      </Link>
      <div className="flex items-center justify-between gap-md">
        <h1 className="font-serif text-[22px] text-ink md:text-[28px]">Scan history</h1>
        <div className="flex items-center gap-sm">
          {rows.length > 0 && (
            <span className="rounded-pill bg-surface-muted px-sm py-xs text-[11px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
              {offset + 1}–{offset + rows.length} of {total}
            </span>
          )}
          <ExportCsvButton rows={rows} />
        </div>
      </div>
      {filterChips}
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
            : {
                title: "No scans yet",
                body: "Photograph an invoice to start building your inventory.",
              };

    return (
      <section>
        {headerBlock}
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <ScanLine className="mb-md h-12 w-12 text-ink-subtle" strokeWidth={1.5} />
          <p className="text-[15px] font-medium text-ink">{emptyCopy.title}</p>
          <p className="mt-xs text-[14px] text-ink-muted">{emptyCopy.body}</p>
          <Link
            href="/scan"
            className="mt-lg inline-flex h-11 items-center gap-sm rounded-sm bg-accent px-lg text-[14px] font-medium text-white hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-accent-soft focus-visible:ring-offset-2"
          >
            Scan an invoice
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section>
      {headerBlock}

      {/* Desktop table */}
      <div className="hidden overflow-hidden rounded-md border border-border md:block">
        <table className="w-full border-collapse text-[14px]">
          <thead>
            <tr className="bg-surface-muted">
              <th scope="col" className="px-md py-sm text-left text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                Date
              </th>
              <th scope="col" className="px-md py-sm text-left text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                Supplier
              </th>
              <th scope="col" className="px-md py-sm text-left text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                Invoice #
              </th>
              <th scope="col" className="px-md py-sm text-center text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                Items
              </th>
              <th scope="col" className="px-md py-sm text-center text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                Status
              </th>
              <th scope="col" className="px-md py-sm text-center text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                Accuracy
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s, i) => (
              <tr
                key={s.id}
                className={`border-t border-border hover:bg-[#FBFAF6] ${
                  i === 0 ? "border-t-0" : ""
                }`}
              >
                <td className="px-md py-sm">
                  <Link
                    href={`/scan/${s.id}`}
                    className="block text-ink hover:text-accent"
                  >
                    <span className="font-mono text-[13px]">
                      {s.invoice_date ?? s.created_at.slice(0, 10)}
                    </span>
                  </Link>
                </td>
                <td className="px-md py-sm">
                  <Link
                    href={`/scan/${s.id}`}
                    className="block font-medium text-ink hover:text-accent"
                  >
                    {s.distributor_name}
                  </Link>
                </td>
                <td className="px-md py-sm">
                  <Link
                    href={`/scan/${s.id}`}
                    className="block font-mono text-[13px] text-ink-muted"
                  >
                    {s.invoice_number ?? "—"}
                  </Link>
                </td>
                <td className="px-md py-sm text-center">
                  <Link
                    href={`/scan/${s.id}`}
                    className="block font-mono tabular text-ink"
                  >
                    {s.item_count}
                  </Link>
                </td>
                <td className="px-md py-sm text-center">
                  <Link href={`/scan/${s.id}`} className="block">
                    <span
                      className={`inline-block rounded-pill px-sm py-2xs text-[11px] font-medium ${statusBadge(s.status)}`}
                    >
                      {statusLabel(s.status)}
                    </span>
                  </Link>
                </td>
                <td className="px-md py-sm text-center">
                  <Link href={`/scan/${s.id}`} className="block">
                    <span className="font-mono text-[13px] text-ink-muted tabular">
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
            className="flex items-center gap-md rounded-md border border-border bg-white p-md hover:bg-[#FBFAF6] focus-visible:ring-2 focus-visible:ring-accent-soft focus-visible:ring-offset-2"
          >
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-sm bg-surface-muted">
              <FileText className="h-5 w-5 text-ink-subtle" strokeWidth={1.5} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14px] font-medium text-ink">
                {s.distributor_name}
              </div>
              <div className="mt-2xs flex items-center gap-sm text-[12px] text-ink-muted">
                <span className="font-mono">
                  {s.invoice_date ?? s.created_at.slice(0, 10)}
                </span>
                {s.invoice_number && (
                  <>
                    <span aria-hidden className="text-ink-subtle">·</span>
                    <span className="font-mono">#{s.invoice_number}</span>
                  </>
                )}
              </div>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-xs">
              <span className="font-mono text-[14px] tabular text-ink">
                {s.item_count}
              </span>
              <span
                className={`inline-block rounded-pill px-sm py-2xs text-[10px] font-medium ${statusBadge(s.status)}`}
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
            className="inline-flex h-10 items-center gap-xs rounded-sm border border-border-strong bg-white px-md text-[13px] font-medium text-ink hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-accent-soft focus-visible:ring-offset-2"
          >
            <ChevronLeft className="h-4 w-4" strokeWidth={2} />
            Previous
          </Link>
        ) : (
          <span className="inline-flex h-10 items-center gap-xs rounded-sm border border-border bg-white px-md text-[13px] font-medium text-ink-muted opacity-50">
            <ChevronLeft className="h-4 w-4" strokeWidth={2} />
            Previous
          </span>
        )}
        <span className="px-sm text-[13px] tabular text-ink-muted">
          Page {page} of {totalPages}
        </span>
        {hasMore ? (
          <Link
            href={`/scans${buildQuery({ page: page + 1, status })}`}
            className="inline-flex h-10 items-center gap-xs rounded-sm border border-border-strong bg-white px-md text-[13px] font-medium text-ink hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-accent-soft focus-visible:ring-offset-2"
          >
            Next
            <ChevronRight className="h-4 w-4" strokeWidth={2} />
          </Link>
        ) : (
          <span className="inline-flex h-10 items-center gap-xs rounded-sm border border-border bg-white px-md text-[13px] font-medium text-ink-muted opacity-50">
            Next
            <ChevronRight className="h-4 w-4" strokeWidth={2} />
          </span>
        )}
      </nav>
    </section>
  );
}
