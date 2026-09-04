/**
 * Cellar section shape and the one reader for it.
 *
 * `cellar_config.labels.sections` is stored two ways: the config editor writes
 * `{id, name}` objects, while the grid-label callers (and every seeded row)
 * write plain name strings. A consumer that assumes one shape silently gets
 * `undefined` names from the other — which is how /cellar filed every wine
 * under "Uncategorized" while `inventory_items.section` was fully populated.
 * Both readers go through `normalizeSections`.
 */
export type CellarSection = { id: string; name: string };

/**
 * Normalizes either stored shape into `{id, name}`, using the name itself as a
 * stable id for the legacy string form so re-fetches don't reshuffle React
 * keys or drag order.
 */
export function normalizeSections(raw: unknown[]): CellarSection[] {
  const usedIds = new Set<string>();

  return raw.map((entry) => {
    const section =
      typeof entry === "string"
        ? { id: entry, name: entry }
        : (entry as CellarSection);
    const baseId = section.id;
    let id = baseId;
    let suffix = 2;

    while (usedIds.has(id)) {
      id = `${baseId}-${suffix}`;
      suffix += 1;
    }

    usedIds.add(id);
    return id === section.id ? section : { ...section, id };
  });
}
