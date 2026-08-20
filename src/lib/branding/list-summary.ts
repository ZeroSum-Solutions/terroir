type SummaryWine = {
  producer: string;
  name: string;
  vintage: number | null;
  varietal?: string | null;
  region?: string | null;
};

type SummaryList = {
  name: string;
  wine_list_sections: Array<{
    name: string;
    wine_list_items: Array<{ wines: SummaryWine | null }>;
  }>;
};

export function buildWineListSummary(list: SummaryList): string {
  const sections = list.wine_list_sections.slice(0, 12).map((section) => {
    const wines = section.wine_list_items
      .slice(0, 30)
      .flatMap((item) => item.wines ?? [])
      .map(formatWine);
    return `${section.name}: ${wines.join("; ") || "empty"}`;
  });
  return [`List: ${list.name}`, ...sections].join("\n").slice(0, 12_000);
}

function formatWine(wine: SummaryWine): string {
  return [
    wine.producer,
    wine.name,
    wine.vintage,
    wine.varietal,
    wine.region,
  ].filter(Boolean).join(" ");
}
