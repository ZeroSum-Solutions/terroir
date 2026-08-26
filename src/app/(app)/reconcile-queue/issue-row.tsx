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
  unplaced: "bg-amber-wash text-amber",
  unmatched_scan: "bg-powder-wash text-powder-ink",
  duplicate_suspect: "bg-blush-wash text-accent",
  ambiguous_lineage: "bg-amber-wash text-amber",
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
      className="grid gap-sm border-t border-hairline px-md py-md first:border-t-0 md:grid-cols-[44px_minmax(0,1fr)_minmax(180px,auto)_100px] md:items-center"
    >
      <label className="flex h-11 w-11 items-center justify-center">
        <span className="sr-only">Select {row.title}</span>
        <input
          type="checkbox"
          aria-label={`Select ${row.title}`}
          checked={checked}
          disabled={disabled || !actionable}
          onChange={onToggle}
          className="h-4 w-4 rounded-sm border-beige-deep text-accent focus:ring-accent disabled:opacity-35"
        />
      </label>
      <IssueIdentity row={row} />
      <IssueControl row={row} bins={bins} binId={binId} onBinChange={onBinChange} />
      <div className="flex items-baseline justify-between gap-md md:block md:text-right">
        <span className="text-caption uppercase text-grey md:hidden">At risk</span>
        <span className="font-mono text-[14px] font-medium tabular-nums text-ink">
          ${formatRisk(row.atRisk)}
        </span>
        <span className="ml-xs text-[11px] tabular-nums text-grey md:block md:ml-0">
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
        <span className={`rounded-pill px-sm py-2xs text-[10.5px] font-medium uppercase tracking-wide ${KIND_STYLES[row.kind]}`}>
          {KIND_LABELS[row.kind]}
        </span>
        {row.suggestion && <BasisChip row={row} />}
      </div>
      {row.deepLink ? (
        <Link href={row.deepLink} className="group inline-flex min-h-11 items-center gap-xs font-serif text-[17px] font-medium text-ink hover:text-accent">
          {row.title}
          <ArrowUpRight className="h-3.5 w-3.5 text-grey group-hover:text-accent" aria-hidden />
        </Link>
      ) : (
        <p className="py-xs font-serif text-[17px] font-medium text-ink">{row.title}</p>
      )}
      <p className="text-[12px] text-grey">{row.detail}</p>
    </div>
  );
}

function BasisChip({ row }: { row: ReconcileQueueRow }) {
  const basis = row.suggestion!.basis;
  const label = basis.kind === "lwin" ? "LWIN" : "Field match";
  const detail = basis.kind === "lwin" ? basis.lwin : basis.fields.join(" · ");
  return (
    <span data-basis={basis.kind} className="rounded-pill bg-sage-wash px-sm py-2xs text-[10.5px] font-medium uppercase tracking-wide text-sage-ink">
      <span>{label}</span><span className="sr-only">{detail}</span>
      <span aria-hidden className="ml-2xs opacity-75">{detail}</span>
    </span>
  );
}

function IssueControl({ row, bins, binId, onBinChange }: Pick<Props, "row" | "bins" | "binId" | "onBinChange">) {
  if (row.kind !== "unplaced") {
    return <p className="text-[12px] text-grey">{row.action?.label ?? "Review in cellar"}</p>;
  }
  if (bins.length === 0) return <p className="text-[12px] text-amber">Create an active bin first</p>;
  return (
    <label className="block">
      <span className="sr-only">Bin for {row.title}</span>
      <select
        aria-label={`Bin for ${row.title}`}
        value={binId ?? ""}
        onChange={(event) => onBinChange(event.target.value)}
        className="h-11 w-full rounded-pill border border-beige-deep bg-surface px-md text-[13px] text-ink focus:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25"
      >
        <option value="">Choose bin</option>
        {bins.map((bin) => <option key={bin.id} value={bin.id}>{bin.zone ? `${bin.zone} · ` : ""}{bin.code}</option>)}
      </select>
    </label>
  );
}

function formatRisk(value: number): string {
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}
