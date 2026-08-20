import Link from "next/link";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  aggregateYieldByPreservation,
  type PreservationMethod,
  type YieldGroup,
} from "@/lib/partial-bottles/math";
import type { Database } from "@/types/database";
import { metricHref } from "./metric-href";

const LABELS: Record<YieldGroup["preservationMethod"], string> = {
  argon: "Argon",
  coravin: "Coravin",
  none: "None",
  vacuum: "Vacuum",
};

export function YieldReportSection({ groups }: { groups: YieldGroup[] }) {
  if (groups.length === 0) return null;

  return (
    <section className="mb-lg md:mb-xl" aria-labelledby="yield-report-heading">
      <div className="mb-md flex items-baseline justify-between gap-sm">
        <h2 id="yield-report-heading" className="text-caption font-medium uppercase text-grey">
          Partial-bottle yield
        </h2>
        <span className="text-[12px] text-grey">Actual excludes write-offs</span>
      </div>
      <div className="grid gap-md md:grid-cols-2">
        {groups.map((group) => {
          const href = "/cellar";
          return (
            <article key={group.preservationMethod} className="rounded-lg border border-hairline bg-bridge-surface p-md">
              <h3 className="text-[14px] font-medium text-ink">{LABELS[group.preservationMethod]}</h3>
              <div className="mt-sm grid grid-cols-2 gap-xs text-[12px] md:grid-cols-4">
                <Metric name={`${group.preservationMethod}-closed`} href={href} value={`${group.bottlesClosed} closed`} />
                <Metric name={`${group.preservationMethod}-variance`} href={href} value={`${formatMl(group.averageVarianceMl)} avg variance`} />
                <Metric name={`${group.preservationMethod}-actual`} href={href} value={`${formatMl(group.actualPouredMl)} actual`} />
                <Metric name={`${group.preservationMethod}-theoretical`} href={href} value={`${formatMl(group.theoreticalPouredMl)} theoretical`} />
              </div>
              <ul className="mt-md divide-y divide-hairline">
                {group.bottles.map((bottle) => (
                  <li key={bottle.bottleId} className="grid grid-cols-2 gap-xs py-xs text-[12px]">
                    <Metric name={`${bottle.bottleId}-actual`} href={metricHref("wine", bottle.wineId)} value={`${formatMl(bottle.actualPouredMl)} actual`} />
                    <Metric name={`${bottle.bottleId}-theoretical`} href={metricHref("wine", bottle.wineId)} value={`${formatMl(bottle.theoreticalPouredMl)} theoretical`} />
                  </li>
                ))}
              </ul>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function Metric({ name, href, value }: { name: string; href: string; value: string }) {
  return (
    <span data-metric={`yield-${name}`}>
      <Link href={href} className="block rounded-sm tabular text-grey hover:bg-beige hover:text-primary">
        {value}
      </Link>
    </span>
  );
}

function formatMl(value: number) {
  return `${Math.round(value)} ml`;
}

export async function fetchYieldGroups(
  supabase: SupabaseClient<Database>,
  restaurantId: string,
  rangeSince: Date | null,
  rangeUntil: Date | null,
) {
  const pageSize = 1_000;
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    let query = supabase
      .from("bottle_closeouts")
      .select("id, open_bottle_id, wine_id, preservation_method, theoretical_remaining_ml, actual_remaining_ml, written_off_ml, wines!inner(size_ml)")
      .eq("restaurant_id", restaurantId)
      .order("closed_at", { ascending: false });
    if (rangeSince) {
      query = query.gte("closed_at", rangeSince.toISOString());
    }
    if (rangeUntil) {
      query = query.lte("closed_at", rangeUntil.toISOString());
    }
    const { data, error } = await query.range(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if ((data?.length ?? 0) < pageSize) break;
  }

  return aggregateYieldByPreservation(rows.map((row) => ({
    bottleId: row.open_bottle_id ?? row.id,
    wineId: row.wine_id,
    preservationMethod: row.preservation_method as PreservationMethod,
    sizeMl: (row.wines as unknown as { size_ml: number }).size_ml,
    theoreticalRemainingMl: row.theoretical_remaining_ml,
    actualRemainingMl: row.actual_remaining_ml,
    writtenOffMl: row.written_off_ml,
  })));
}
