import { z } from "zod";
import type { CellarGroupBy, CellarFacets } from ".";
import { CELLAR_SORTS, type CellarSort } from "./sort";
import {
  HEALTH_SEGMENTS,
  type CellarHealthSegment,
} from "@/lib/cellar-health/classify";

export const CELLAR_FILTERS = [
  "all",
  "open",
  "out",
  "low",
  "drink-now",
  "hold",
] as const;

export type CellarUrlFilter = (typeof CELLAR_FILTERS)[number];

/**
 * List or the bin grid. In the URL because the grid is a destination: a phone
 * could not reach it at all while the view lived in `useState` — the List/Grid
 * toggle is the only way in and it was desktop-only — and `/cellar?view=grid`
 * is what makes it linkable from anywhere else.
 */
export const CELLAR_VIEWS = ["list", "grid"] as const;

export type CellarView = (typeof CELLAR_VIEWS)[number];

export type CellarUrlState = CellarFacets & {
  q: string;
  filter: CellarUrlFilter;
  colour: string | null;
  producer: string | null;
  region: string | null;
  country: string | null;
  varietal: string | null;
  vintageMin: number | null;
  vintageMax: number | null;
  format: number | null;
  groupBy: CellarGroupBy | null;
  health: CellarHealthSegment | null;
  sort: CellarSort | null;
  view: CellarView;
  wine: string | null;
};

type SearchParamsReader = { get(name: string): string | null };

const textSchema = z.string().trim().min(1).max(200);
const querySchema = z.string().trim().max(200);
const positiveIntSchema = z.coerce.number().int().positive();
const vintageSchema = z.coerce.number().int().min(1000).max(3000);
const filterSchema = z.enum(CELLAR_FILTERS);
const groupSchema = z.enum(["producer", "region", "varietal", "vintage"]);
const healthSchema = z.enum(HEALTH_SEGMENTS);
const sortSchema = z.enum(CELLAR_SORTS);
const viewSchema = z.enum(CELLAR_VIEWS);
const wineSchema = z.string().uuid();

export function parseCellarUrlState(params: SearchParamsReader): CellarUrlState {
  return {
    q: parseValue(querySchema, params.get("q")) ?? "",
    filter: parseValue(filterSchema, params.get("filter")) ?? "all",
    colour: parseValue(textSchema, params.get("colour")),
    producer: parseValue(textSchema, params.get("producer")),
    region: parseValue(textSchema, params.get("region")),
    country: parseValue(textSchema, params.get("country")),
    varietal: parseValue(textSchema, params.get("varietal")),
    vintageMin: parseValue(vintageSchema, params.get("vintage_min")),
    vintageMax: parseValue(vintageSchema, params.get("vintage_max")),
    format: parseValue(positiveIntSchema, params.get("format")),
    groupBy: parseValue(groupSchema, params.get("group_by")),
    health: parseValue(healthSchema, params.get("health")),
    sort: parseValue(sortSchema, params.get("sort")),
    view: parseValue(viewSchema, params.get("view")) ?? "list",
    wine: parseValue(wineSchema, params.get("wine")),
  };
}

export function serializeCellarUrlState(state: CellarUrlState): URLSearchParams {
  const params = new URLSearchParams();
  setText(params, "q", state.q);
  params.set("filter", state.filter);
  setText(params, "colour", state.colour);
  setText(params, "producer", state.producer);
  setText(params, "region", state.region);
  setText(params, "country", state.country);
  setText(params, "varietal", state.varietal);
  setNumber(params, "vintage_min", state.vintageMin);
  setNumber(params, "vintage_max", state.vintageMax);
  setNumber(params, "format", state.format);
  setText(params, "group_by", state.groupBy);
  setText(params, "health", state.health);
  setText(params, "sort", state.sort);
  // List is the default, so it is never written: `?view=grid` is the only
  // form that has to survive a round trip, and every other cellar URL stays
  // as short as it was.
  setText(params, "view", state.view === "list" ? null : state.view);
  setText(params, "wine", state.wine);
  return params;
}

function parseValue<T>(schema: z.ZodType<T>, value: string | null): T | null {
  if (value === null) return null;
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function setText(params: URLSearchParams, key: string, value: string | null) {
  if (value) params.set(key, value);
}

function setNumber(params: URLSearchParams, key: string, value: number | null) {
  if (value != null) params.set(key, String(value));
}
