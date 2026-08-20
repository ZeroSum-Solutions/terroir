import {
  type CellarFacets,
  type CellarGroupBy,
  type FacetCount,
  type FacetCounts,
} from "@/lib/cellar-facets";

export type CellarFacetPatch = Partial<
  Pick<
    CellarFacets,
    | "producer"
    | "region"
    | "country"
    | "varietal"
    | "vintageMin"
    | "vintageMax"
    | "format"
    | "health"
  >
>;

export function CellarFacetBar({
  facets,
  counts,
  groupBy,
  onFacetsChange,
  onGroupByChange,
}: {
  facets: CellarFacets;
  counts: FacetCounts;
  groupBy: CellarGroupBy | null;
  onFacetsChange: (patch: CellarFacetPatch) => void;
  onGroupByChange: (groupBy: CellarGroupBy | null) => void;
}) {
  const hasFacets = Object.values(facets).some((value) => value != null);

  return (
    <div
      data-cellar-facet-bar
      className="mb-md flex items-center gap-xs overflow-x-auto rounded-md border border-hairline bg-white p-xs md:flex-wrap"
    >
      <FacetSelect
        label="Producer"
        value={facets.producer}
        options={counts.producer}
        onChange={(producer) => onFacetsChange({ producer })}
      />
      <FacetSelect
        label="Region"
        value={facets.region}
        options={counts.region}
        onChange={(region) => onFacetsChange({ region })}
      />
      <FacetSelect
        label="Country"
        value={facets.country}
        options={counts.country}
        onChange={(country) => onFacetsChange({ country })}
      />
      <FacetSelect
        label="Varietal"
        value={facets.varietal}
        options={counts.varietal}
        onChange={(varietal) => onFacetsChange({ varietal })}
      />
      <NumberFacetSelect
        label="Vintage from"
        value={facets.vintageMin}
        options={counts.vintage}
        onChange={(vintageMin) => onFacetsChange({ vintageMin })}
      />
      <NumberFacetSelect
        label="Vintage to"
        value={facets.vintageMax}
        options={counts.vintage}
        onChange={(vintageMax) => onFacetsChange({ vintageMax })}
      />
      <NumberFacetSelect
        label="Format"
        value={facets.format}
        options={counts.format}
        formatLabel={(option) => `${option.label} ml (${option.count})`}
        onChange={(format) => onFacetsChange({ format })}
      />
      <label className="shrink-0">
        <span className="sr-only">Group by</span>
        <select
          aria-label="Group by"
          value={groupBy ?? ""}
          onChange={(event) =>
            onGroupByChange((event.target.value || null) as CellarGroupBy | null)
          }
          className={selectClassName}
        >
          <option value="">Group by</option>
          <option value="producer">Producer</option>
          <option value="region">Region</option>
          <option value="varietal">Varietal</option>
          <option value="vintage">Vintage</option>
        </select>
      </label>
      {hasFacets && (
        <button
          type="button"
          onClick={() =>
            onFacetsChange({
              producer: null,
              region: null,
              country: null,
              varietal: null,
              vintageMin: null,
              vintageMax: null,
              format: null,
              health: null,
            })
          }
          className="h-11 shrink-0 rounded-pill px-sm text-[12px] font-medium text-grey hover:bg-bridge-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25 md:h-9"
        >
          Clear facets
        </button>
      )}
    </div>
  );
}

function FacetSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | null | undefined;
  options: FacetCount[];
  onChange: (value: string | null) => void;
}) {
  const selected = options.find(
    (option) => option.value.toLocaleLowerCase() === value?.toLocaleLowerCase(),
  );
  const renderedOptions =
    value && !selected
      ? [...options, { value, label: value, count: 0, isUnknown: false }]
      : options;
  return (
    <label className="shrink-0">
      <span className="sr-only">{label}</span>
      <select
        aria-label={label}
        value={selected?.value ?? value ?? ""}
        onChange={(event) => onChange(event.target.value || null)}
        className={selectClassName}
      >
        <option value="">All {label.toLocaleLowerCase()}</option>
        {renderedOptions.map((option) => (
          <option
            key={option.value}
            value={option.value}
            disabled={option.isUnknown}
          >
            {option.label} ({option.count})
          </option>
        ))}
      </select>
    </label>
  );
}

function NumberFacetSelect({
  label,
  value,
  options,
  onChange,
  formatLabel = (option) => `${option.label} (${option.count})`,
}: {
  label: string;
  value: number | null | undefined;
  options: FacetCount[];
  onChange: (value: number | null) => void;
  formatLabel?: (option: FacetCount) => string;
}) {
  const renderedOptions =
    value != null && !options.some((option) => Number(option.value) === value)
      ? [...options, { value: String(value), label: String(value), count: 0, isUnknown: false }]
      : options;
  return (
    <label className="shrink-0">
      <span className="sr-only">{label}</span>
      <select
        aria-label={label}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value ? Number(event.target.value) : null)}
        className={selectClassName}
      >
        <option value="">{label}</option>
        {renderedOptions
          .filter((option) => !option.isUnknown)
          .map((option) => (
            <option key={option.value} value={option.value}>
              {formatLabel(option)}
            </option>
          ))}
      </select>
    </label>
  );
}

const selectClassName =
  "h-11 max-w-[180px] rounded-pill border border-ink/20 bg-white px-sm text-[12px] text-ink outline-none hover:bg-bridge-surface focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-primary/15 md:h-9";
