"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import type { WineAvailabilityRow } from "./page";
import { NoteModal } from "./note-modal";

interface AvailabilityListProps {
  initialRows: WineAvailabilityRow[];
  canToggle: boolean;
}

type PendingToggle = {
  wineId: string;
  direction: "eightysixed" | "restored";
  wineName: string;
};

export function AvailabilityList({
  initialRows,
  canToggle,
}: AvailabilityListProps) {
  const router = useRouter();
  const [rows, setRows] = useState(initialRows);
  const [query, setQuery] = useState("");
  const [showOnly86d, setShowOnly86d] = useState(false);
  const [pending, setPending] = useState<PendingToggle | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (showOnly86d && !r.is_eightysixed) return false;
      if (!q) return true;
      return (
        r.name.toLowerCase().includes(q) ||
        r.producer.toLowerCase().includes(q) ||
        (r.varietal ?? "").toLowerCase().includes(q) ||
        (r.region ?? "").toLowerCase().includes(q)
      );
    });
  }, [rows, query, showOnly86d]);

  const onToggleClick = (row: WineAvailabilityRow) => {
    setErrorMsg(null);
    const direction = row.is_eightysixed ? "restored" : "eightysixed";
    setPending({
      wineId: row.id,
      direction,
      wineName: `${row.producer} ${row.name}${row.vintage ? ` ${row.vintage}` : ""}`,
    });
  };

  const onConfirm = async (note: string | undefined) => {
    if (!pending) return;
    const target = pending;
    setPending(null);

    // Optimistic: flip state locally while the request is in flight.
    setRows((prev) =>
      prev.map((r) =>
        r.id === target.wineId
          ? {
              ...r,
              is_eightysixed: target.direction === "eightysixed",
              eightysixed_at:
                target.direction === "eightysixed"
                  ? new Date().toISOString()
                  : null,
            }
          : r,
      ),
    );

    try {
      const res = await fetch(
        `/api/wines/${target.wineId}/availability`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ direction: target.direction, note }),
        },
      );

      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(payload?.error ?? `Request failed (${res.status}).`);
      }

      // router.refresh() re-fetches the server component so the metadata
      // (precise timestamp from the RPC, eightysixed_by uuid) is accurate
      // on next render.
      startTransition(() => router.refresh());
    } catch (err) {
      // Revert optimistic update.
      setRows(initialRows);
      setErrorMsg(err instanceof Error ? err.message : "Toggle failed.");
    }
  };

  return (
    <div>
      <div className="mb-lg flex flex-col gap-sm sm:flex-row sm:items-center sm:justify-between">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name, producer, varietal, region…"
          className="h-[38px] w-full rounded-sm border border-border bg-white px-sm text-[14px] text-ink outline-none focus-visible:border-accent focus-visible:ring-[3px] focus-visible:ring-accent-soft sm:max-w-[360px]"
        />
        <label className="flex items-center gap-xs text-[13px] text-ink-muted">
          <input
            type="checkbox"
            checked={showOnly86d}
            onChange={(e) => setShowOnly86d(e.target.checked)}
          />
          Show only 86&apos;d
        </label>
      </div>

      {errorMsg && (
        <div className="mb-md rounded-sm border border-danger/30 bg-danger-soft px-md py-sm text-[13px] text-danger">
          {errorMsg}
        </div>
      )}

      <ul className="flex flex-col divide-y divide-border rounded-md border border-border bg-white">
        {filtered.length === 0 ? (
          <li className="px-md py-lg text-center text-[13px] text-ink-muted">
            No wines match.
          </li>
        ) : (
          filtered.map((row) => (
            <li
              key={row.id}
              className="flex flex-col gap-xs px-md py-sm sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <div className="font-serif text-[15px] text-ink">
                  {row.producer} {row.name}
                  {row.vintage && (
                    <span className="ml-xs font-mono text-[12px] text-ink-muted">
                      {row.vintage}
                    </span>
                  )}
                </div>
                <div className="text-[12px] text-ink-muted">
                  {row.region}
                  {row.varietal ? ` · ${row.varietal}` : ""}
                </div>
                {row.is_eightysixed && row.eightysixed_at && (
                  <div className="mt-2xs text-[11px] text-ink-subtle">
                    86&apos;d · {new Date(row.eightysixed_at).toLocaleString()}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-sm">
                <span
                  className={cn(
                    "rounded-full px-sm py-2xs text-[11px] font-medium",
                    row.is_eightysixed
                      ? "bg-warning-soft text-warning"
                      : "bg-success-soft text-success",
                  )}
                >
                  {row.is_eightysixed ? "86'd" : "Available"}
                </span>
                {canToggle && (
                  <button
                    type="button"
                    onClick={() => onToggleClick(row)}
                    className={cn(
                      "h-[38px] rounded-sm px-md text-[13px] font-medium",
                      row.is_eightysixed
                        ? "bg-accent text-white hover:bg-accent-hover"
                        : "border border-border-strong bg-white text-ink hover:bg-surface-muted",
                    )}
                  >
                    {row.is_eightysixed ? "Restore" : "86"}
                  </button>
                )}
              </div>
            </li>
          ))
        )}
      </ul>

      <NoteModal
        open={pending !== null}
        wineName={pending?.wineName ?? ""}
        direction={pending?.direction ?? "eightysixed"}
        onCancel={() => setPending(null)}
        onConfirm={onConfirm}
      />
    </div>
  );
}
