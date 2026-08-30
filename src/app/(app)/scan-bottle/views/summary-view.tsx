"use client";

import { Camera, MapPin } from "lucide-react";
import type { SessionScan } from "../scan-bottle-state";

interface SummaryViewProps {
  session: SessionScan[];
  onNewSession: () => void;
}

export function SummaryView({ session, onNewSession }: SummaryViewProps) {
  return (
    <div className="space-y-md">
      <div className="rounded-card card-surface p-md md:p-lg">
        <h2 className="font-serif text-[18px] text-ink">Session summary</h2>
        <p className="mt-xs text-[13px] text-grey">
          {session.length} bottle{session.length !== 1 ? "s" : ""} scanned
          in this session.
        </p>
      </div>

      {session.length > 0 ? (
        <ul className="divide-y divide-rule rounded-card card-surface">
          {session.map((scan, i) => (
            <li key={i} className="px-md py-md">
              <div className="flex items-start justify-between gap-sm">
                <div className="min-w-0">
                  <p className="font-serif text-[17px] font-medium text-ink truncate">
                    {scan.wine.producer}
                  </p>
                  <p className="text-[14px] text-grey truncate">
                    {scan.wine.name}
                    {scan.wine.vintage ? " (" + scan.wine.vintage + ")" : ""}
                  </p>
                </div>
                <span className="shrink-0 rounded-pill bg-wash px-sm py-2xs text-[11px] font-medium text-grey tabular">
                  #{i + 1}
                </span>
              </div>
              <p className="mt-xs inline-flex items-center gap-xs text-[12px] text-grey">
                <MapPin className="h-3 w-3" strokeWidth={2} />
                {scan.section}{" "}
                <span aria-hidden>&middot;</span>{" "}
                {scan.binLocation}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex flex-col items-center gap-md rounded-card card-surface px-lg py-2xl text-center">
          <p className="text-[14px] text-grey">
            No bottles were scanned in this session.
          </p>
        </div>
      )}

      <button
        type="button"
        onClick={onNewSession}
        className="flex h-[44px] w-full items-center justify-center gap-sm rounded-pill bg-primary text-[14px] font-medium text-seal-ink hover:bg-primary-hover focus-ring"
      >
        <Camera className="h-4 w-4" strokeWidth={2} />
        Start new session
      </button>
    </div>
  );
}
