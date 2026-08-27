#!/usr/bin/env -S pnpm exec tsx
// Atlas v1 (recon lane "atlas-map") — precomputes world country outlines as
// flat SVG path data so the client ships zero geo-library runtime weight.
//
// d3-geo / topojson-client / world-atlas are devDependencies ONLY — nothing
// in src/ imports them. This script projects the world-atlas 110m country
// topology with d3-geo (geoEqualEarth) into a ~960x500 viewBox and writes
// the resulting <path d> strings + display name + centroid to a committed,
// generated TS module that ships to the client instead.
//
// Usage: pnpm run atlas:geo
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { geoEqualEarth, geoPath } from "d3-geo";
import { feature } from "topojson-client";
import type { Topology, GeometryCollection } from "topojson-specification";
import type { FeatureCollection, Geometry } from "geojson";

const WIDTH = 960;
const HEIGHT = 500;

const OUT_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/lib/atlas/world-paths.generated.ts",
);

type CountryProperties = { name: string };

function main() {
  // world-atlas ships pre-quantized TopoJSON; countries-110m is the
  // lowest-resolution tier — right-sized for a whole-world overview map,
  // not for zooming into small countries (v2 tradeoff, see recon brief).
  const topologyPath = require.resolve("world-atlas/countries-110m.json");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const topology = require(topologyPath) as Topology;
  const countriesObject = topology.objects.countries as GeometryCollection<CountryProperties>;
  const collection = feature(topology, countriesObject) as unknown as FeatureCollection<
    Geometry,
    CountryProperties
  >;

  const projection = geoEqualEarth().fitSize([WIDTH, HEIGHT], collection);
  const pathGenerator = geoPath(projection);

  const entries: Record<string, { d: string; name: string; centroid: [number, number] }> = {};

  for (const featureItem of collection.features) {
    const id = featureItem.id != null ? String(featureItem.id) : null;
    const name = featureItem.properties?.name;
    const d = pathGenerator(featureItem);
    if (!id || !name || !d) continue; // skip any geometry the projector can't render
    const centroid = pathGenerator.centroid(featureItem);
    entries[id] = { d, name, centroid: [round(centroid[0]), round(centroid[1])] };
  }

  const sortedKeys = Object.keys(entries).sort();
  const body = sortedKeys
    .map((key) => {
      const entry = entries[key];
      return `  ${JSON.stringify(key)}: { d: ${JSON.stringify(entry.d)}, name: ${JSON.stringify(entry.name)}, centroid: [${entry.centroid[0]}, ${entry.centroid[1]}] },`;
    })
    .join("\n");

  const output = `// GENERATED FILE — do not edit by hand.
// Regenerate with \`pnpm run atlas:geo\` (scripts/build-atlas-geo.ts).
//
// World country outlines from world-atlas's countries-110m topology,
// projected with d3-geo (geoEqualEarth) into a ${WIDTH}x${HEIGHT} viewBox.
// Keyed by ISO 3166-1 numeric code (as a string) — the id world-atlas
// bakes into each country geometry. src/lib/atlas/country-lookup.ts maps
// free-text wine \`country\` values onto these same keys.

export const ATLAS_VIEWBOX = "0 0 ${WIDTH} ${HEIGHT}";

export type AtlasCountryPath = {
  /** SVG path "d" attribute for this country's outline. */
  d: string;
  /** Display name from the source atlas (English). */
  name: string;
  /** Projected [x, y] centroid, for label/marker placement. */
  centroid: [number, number];
};

export const WORLD_COUNTRY_PATHS: Record<string, AtlasCountryPath> = {
${body}
};
`;

  writeFileSync(OUT_FILE, output);
  console.log(`Wrote ${sortedKeys.length} country paths to ${path.relative(process.cwd(), OUT_FILE)}`);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

main();
