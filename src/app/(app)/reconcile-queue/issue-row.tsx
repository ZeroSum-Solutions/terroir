import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { ReconcileQueueKind, ReconcileQueueRow } from "@/lib/reconcile-queue";
import { buildAcceptAction } from "./accept-action";
import type { QueueBin } from "./types";

const KIND_LABELS: Record<ReconcileQueueKind, string> = {
  unplaced: "Unplaced",
  unmatched_scan: "Unmatched scan",
  duplicate_suspect: "Duplicate suspect",
  ambiguous_lineage: "Ambiguous lineage",
};

const KIND_STYLES: Record<ReconcileQueueKind, string> = {
  unplaced: "bg-warning-soft text-warning",
  unmatched_scan: "bg-accent-soft text-accent",
  duplicate_suspect: "bg-danger-soft text-danger",
  ambiguous_lineage: "bg-warning-soft text-warning",
};

type Props = {
  row: ReconcileQueueRow;
  bins: QueueBin[];
  binId?: string;
  checked: boolean;
  disabled: boolean;
  onBinChange: (binId: string) => void;
  onToggle: () => void;
};

export function QueueIssueRow(props: Props) {
  const { row, bins, binId, checked, disabled, onBinChange, onToggle } = props;
  const actionable = buildAcceptAction(row, binId) !== null;
  return (
    <article
      data-queue-row
      data-queue-kind={row.kind}
      data-risk={row.atRisk}
      className="grid gap-sm border-t border-dashed border-border px-md py-md first:border-t-0 md:grid-cols-[44px_minmax(0,1fr)_minmax(180px,auto)_100px] md:items-center"
    >
      <label className="flex h-11 w-11 items-center justify-center">
        <span className="sr-only">Select {row.title}</span>
        <input
          type="checkbox"
          aria-label={`Select ${row.title}`}
          checked={checked}
          disabled={disabled || !actionable}
          onChange={onToggle}
          className="h-4 w-4 rounded-sm border-border-strong text-accent focus:ring-accent disabled:opacity-35"
        />
      </label>
      <IssueIdentity row={row} />
      <IssueControl row={row} bins={bins} binId={binId} onBinChange={onBinChange} />
      <div className="flex items-baseline justify-between gap-md md:block md:text-right">
        <span className="text-[11px] uppercase tracking-[0.08em] text-ink-subtle md:hidden">At risk</span>
        <span className="font-mono text-[14px] font-medium tabular-nums text-ink">
          ${formatRisk(row.atRisk)}
        </span>
        <span className="ml-xs text-[11px] tabular-nums text-ink-muted md:block md:ml-0">
          {row.units} units
        </span>
      </div>
    </article>
  );
}

function IssueIdentity({ row }: { row: ReconcileQueueRow }) {
  return (
    <div className="min-w-0">
      <div className="mb-xs flex flex-wrap items-center gap-xs">
        <span className={`rounded-sm px-xs py-2xs text-[10px] font-semibold uppercase tracking-[0.06em] ${KIND_STYLES[row.kind]}`}>
          {KIND_LABELS[row.kind]}
        </span>
        {row.suggestion && <BasisChip row={row} />}
      </div>
      {row.deepLink ? (
        <Link href={row.deepLink} className="group inline-flex min-h-11 items-center gap-xs font-serif text-[16px] text-ink hover:text-accent">
          {row.title}
          <ArrowUpRight className="h-3.5 w-3.5 text-ink-subtle group-hover:text-accent" aria-hidden />
        </Link>
      ) : (
        <p className="py-xs font-serif text-[16px] text-ink">{row.title}</p>
      )}
      <p className="text-[12px] text-ink-muted">{row.detail}</p>
    </div>
  );
}

function BasisChip({ row }: { row: ReconcileQueueRow }) {
  const basis = row.suggestion!.basis;
  const label = basis.kind === "lwin" ? "LWIN" : "Field match";
  const detail = basis.kind === "lwin" ? basis.lwin : basis.fields.join(" · ");
  return (
    <span data-basis={basis.kind} className="rounded-sm bg-success-soft px-xs py-2xs text-[10px] font-medium text-success">
      <span>{label}</span><span className="sr-only">{detail}</span>
      <span aria-hidden className="ml-2xs opacity-75">{detail}</span>
    </span>
  );
}

function IssueControl({ row, bins, binId, onBinChange }: Pick<Props, "row" | "bins" | "binId" | "onBinChange">) {
  if (row.kind !== "unplaced") {
    return <p className="text-[12px] text-ink-muted">{row.action?.label ?? "Review in cellar"}</p>;
  }
  if (bins.length === 0) return <p className="text-[12px] text-warning">Create an active bin first</p>;
  return (
    <label className="block">
      <span className="sr-only">Bin for {row.title}</span>
      <select
        aria-label={`Bin for ${row.title}`}
        value={binId ?? ""}
        onChange={(event) => onBinChange(event.target.value)}
        className="h-11 w-full rounded-sm border border-border-strong bg-white px-sm text-[13px] text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft"
      >
        <option value="">Choose bin</option>
        {bins.map((bin) => <option key={bin.id} value={bin.id}>{bin.zone ? `${bin.zone} · ` : ""}{bin.code}</option>)}
      </select>
    </label>
  );
}

function formatRisk(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}
