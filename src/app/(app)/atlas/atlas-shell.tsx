"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { X } from "lucide-react";
import { useFocusTrap } from "@/lib/hooks/use-focus-trap";
import type { CellarFacetRow, FacetCount } from "@/lib/cellar-facets";
import {
  aggregateAtlasCountries,
  regionsForCountry,
  type AtlasCountryAggregate,
} from "@/lib/atlas/aggregate";
import { AtlasWorldMap } from "./atlas-world-map";

/**
 * Atlas v1 (recon lane "atlas-map") — owns which country is tapped and
 * renders the map + its region bottom sheet. Mirrors cellar's own
 * dawn-hero header and the filter sheet's dialog/scrim idiom
 * (cellar-filter-sheet.tsx) rather than inventing a new drawer pattern.
 */
export function AtlasShell({
  rows,
  restaurantName,
}: {
  rows: CellarFacetRow[];
  restaurantName: string;
}) {
  const { countries, unmatched } = useMemo(() => aggregateAtlasCountries(rows), [rows]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const hasCountryData = countries.length > 0 || unmatched.length > 0;

  const selectedCountry = countries.find((c) => c.key === selectedKey) ?? null;
  const regions = useMemo(
    () => (selectedCountry ? regionsForCountry(rows, selectedCountry.rawLabels) : []),
    [rows, selectedCountry],
  );

  return (
    <section className="min-w-0 max-w-full overflow-x-hidden">
      <div className="-mx-md -mt-lg dawn-gradient px-md pb-lg pt-lg md:-mx-lg md:-mt-xl md:px-lg md:pb-xl md:pt-xl">
        <p className="truncate text-caption font-medium uppercase text-grey">
          {restaurantName} · Atlas
        </p>
        <h1 className="mt-xs max-w-[560px] font-serif text-heading-sm font-light leading-[1.1] text-ink md:text-heading">
          Every bottle has a <em className="italic font-normal text-accent">home</em>
        </h1>
      </div>

      {!hasCountryData ? (
        <p className="px-md py-2xl text-center text-body-sm text-grey md:px-lg">
          No country data yet — add a country to your wines to see them on the map.
        </p>
      ) : (
        <div className="px-md py-md md:px-lg">
          <AtlasWorldMap
            countries={countries}
            selectedKey={selectedKey}
            onSelect={setSelectedKey}
          />
        </div>
      )}

      {unmatched.length > 0 && (
        <div className="px-md pb-lg md:px-lg">
          <h2 className="text-caption font-medium uppercase text-grey">Unmapped</h2>
          <p className="mt-2xs text-body-sm text-grey">
            These country labels on your wines didn&apos;t match a place on the map.
          </p>
          <ul className="mt-sm flex flex-col divide-y divide-hairline rounded-card card-surface">
            {unmatched.map((entry) => (
              <li key={entry.label} className="flex items-center justify-between px-md py-sm">
                <span className="text-body-sm text-ink">{entry.label}</span>
                <span className="font-mono tabular-nums text-body-sm text-grey">
                  {entry.bottles}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {selectedCountry && (
        <AtlasRegionSheet
          country={selectedCountry}
          regions={regions}
          onClose={() => setSelectedKey(null)}
        />
      )}
    </section>
  );
}

function AtlasRegionSheet({
  country,
  regions,
  onClose,
}: {
  country: AtlasCountryAggregate;
  regions: FacetCount[];
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingId = "atlas-region-sheet-heading";

  useFocusTrap({ containerRef: dialogRef, onEscape: onClose });

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const namedRegions = regions.filter((region) => !region.isUnknown);
  const unknownRegion = regions.find((region) => region.isUnknown);
  // rawLabels[0] — the actual wines.country spelling to filter /cellar by.
  // A country resolved from more than one raw spelling (rare) will only
  // link through its first-seen spelling; cellar's own URL-state contract
  // matches text exactly, not by alias.
  const countryParam = country.rawLabels[0];

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-scrim md:items-center"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        className="flex max-h-[75vh] w-full flex-col overflow-hidden rounded-t-card bg-surface md:max-w-[440px] md:rounded-card md:border md:border-hairline"
      >
        <header className="flex items-center justify-between border-b border-hairline px-md py-sm">
          <h2 id={headingId} className="font-serif text-subheading font-medium text-ink">
            {country.label}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-11 w-11 items-center justify-center rounded-pill text-grey hover:bg-bridge-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <X className="h-5 w-5" strokeWidth={2} aria-hidden />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-md py-md">
          {namedRegions.length === 0 && !unknownRegion ? (
            <p className="py-md text-center text-body-sm text-grey">No regions recorded.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-hairline">
              {namedRegions.map((region) => (
                <li key={region.value}>
                  <Link
                    href={`/cellar?country=${encodeURIComponent(countryParam)}&region=${encodeURIComponent(region.label)}`}
                    className="flex min-h-11 items-center justify-between gap-md py-sm text-body-sm text-ink hover:text-accent"
                  >
                    <span className="truncate">{region.label}</span>
                    <span className="font-mono tabular-nums text-grey">{region.count}</span>
                  </Link>
                </li>
              ))}
              {unknownRegion && (
                <li className="flex min-h-11 items-center justify-between gap-md py-sm text-body-sm text-grey">
                  <span>Unknown</span>
                  <span className="font-mono tabular-nums">{unknownRegion.count}</span>
                </li>
              )}
            </ul>
          )}
        </div>

        <footer className="border-t border-hairline px-md py-sm">
          <Link
            href={`/cellar?country=${encodeURIComponent(countryParam)}`}
            className="flex min-h-11 items-center justify-center rounded-pill text-body-sm font-medium text-accent hover:underline"
          >
            View all {country.wines} in {country.label}
          </Link>
        </footer>
      </div>
    </div>
  );
}
