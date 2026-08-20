export type MetricKey =
  | "inventory-value"
  | "bottles-in"
  | "eightysixed-count"
  | "drink-now-count"
  | "varietal"
  | "wine";

type FixedMetricKey = Exclude<MetricKey, "varietal" | "wine">;

export function metricHref(metric: FixedMetricKey): string;
export function metricHref(metric: "varietal" | "wine", value: string): string;
export function metricHref(metric: MetricKey, value?: string): string {
  switch (metric) {
    case "eightysixed-count":
      return "/cellar?filter=out";
    case "drink-now-count":
      return "/cellar?filter=drink-now";
    case "varietal":
      return `/cellar?varietal=${encodeURIComponent(value ?? "")}`;
    case "wine":
      return `/cellar?wine=${encodeURIComponent(value ?? "")}`;
    case "inventory-value":
    case "bottles-in":
      return "/cellar";
  }
}
