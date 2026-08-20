"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { MemberAnalyticsResult } from "@/lib/member-analytics";

export function MemberAnalyticsSection() {
  const [data, setData] = useState<MemberAnalyticsResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/member-analytics", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Unable to load member analytics.");
        return response.json() as Promise<MemberAnalyticsResult>;
      })
      .then(setData)
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError(cause instanceof Error ? cause.message : "Unable to load member analytics.");
      });
    return () => controller.abort();
  }, []);

  if (error) return <p role="alert" className="mt-lg text-[13px] text-primary">{error}</p>;
  if (!data) return <div className="mt-lg h-32 animate-pulse rounded-md bg-bridge-surface" />;
  return <MemberAnalyticsTable data={data} />;
}

export function MemberAnalyticsTable({ data }: { data: MemberAnalyticsResult }) {
  return (
    <section aria-labelledby="member-analytics-heading" className="mt-xl rounded-card border border-hairline bg-white p-md">
      <div className="mb-md flex flex-wrap items-baseline justify-between gap-xs">
        <h2 id="member-analytics-heading" className="text-[15px] font-semibold text-ink">Member analytics</h2>
        <span className="text-[12px] text-grey">House median {formatRate(data.houseMedianCompRate)}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] text-left text-[12px]">
          <thead className="text-[11px] font-medium uppercase tracking-[0.18em] text-grey">
            <tr><th className="pb-sm">Member</th><th className="pb-sm">Pours</th><th className="pb-sm">Comps</th><th className="pb-sm">Comp rate vs median</th><th className="pb-sm">Close-out variance</th></tr>
          </thead>
          <tbody>
            {data.members.map((member) => {
              const anchor = `/team#member-${encodeURIComponent(member.userId)}`;
              return (
                <tr id={`member-${member.userId}`} key={member.memberId} className="border-t border-hairline align-top hover:bg-bridge-surface">
                  <td className="py-sm pr-md"><span className="font-mono text-ink">{shortId(member.userId)}</span><span className="ml-xs text-grey">{member.role}</span>{member.requiresVarianceInvestigation && <span className="mt-xs block w-fit rounded-pill bg-amber-wash px-sm py-2xs text-[10.5px] font-medium uppercase tracking-wide text-amber">Variance investigation</span>}</td>
                  <Metric href={anchor} name={`member-${member.userId}-pours`}>{member.pourCount} · {member.pourMl.toLocaleString()} ml</Metric>
                  <Metric href={anchor} name={`member-${member.userId}-comps`}>{member.compCount}</Metric>
                  <Metric href={anchor} name={`member-${member.userId}-comp-rate`}>{member.compRate === null ? "no activity" : `${formatRate(member.compRate)} · ${signed(member.compRate - data.houseMedianCompRate)}`}</Metric>
                  <Metric href={anchor} name={`member-${member.userId}-variance`}>{signedMl(member.closeoutVarianceMl)} · {member.closeoutCount} close-outs</Metric>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Metric({ href, name, children }: { href: string; name: string; children: React.ReactNode }) {
  return <td data-metric={name} className="py-sm pr-md"><Link href={href} className="text-ink underline decoration-beige-deep underline-offset-2">{children}</Link></td>;
}

function formatRate(rate: number) {
  return `${(rate * 100).toFixed(1)}%`;
}

function signed(delta: number) {
  const percentage = `${Math.abs(delta * 100).toFixed(1)} pts`;
  return delta === 0 ? "at median" : `${delta > 0 ? "+" : "−"}${percentage}`;
}

function signedMl(value: number) {
  if (value === 0) return "0 ml";
  return `${value > 0 ? "+" : "−"}${Math.abs(value).toLocaleString()} ml`;
}

function shortId(userId: string) {
  return userId.length > 12 ? `${userId.slice(0, 8)}…` : userId;
}
