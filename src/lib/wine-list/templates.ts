type WineData = {
  name: string;
  producer: string;
  vintage: number | null;
  region: string | null;
  varietal: string | null;
};

type ItemData = {
  glass_price: number | null;
  bottle_price: number | null;
  tasting_note: string | null;
  name_override: string | null;
  wines: WineData;
};

type SectionData = {
  name: string;
  items: ItemData[];
};

type ListData = {
  name: string;
  restaurantName: string;
  sections: SectionData[];
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatPrice(n: number | null): string {
  if (n == null) return "";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function renderItem(item: ItemData, template: "classic" | "modern" | "minimal"): string {
  const w = item.wines;
  const name = escapeHtml(item.name_override ?? `${w.producer} ${w.name}`);
  const vintage = w.vintage ? ` ${w.vintage}` : "";
  const region = w.region ? escapeHtml(w.region) : "";
  const glass = formatPrice(item.glass_price);
  const bottle = formatPrice(item.bottle_price);
  const prices = [glass, bottle].filter(Boolean).join(" / ");

  if (template === "classic") {
    return `
      <div class="wine-item">
        <div class="wine-line">
          <span class="wine-name">${name}${vintage}</span>
          <span class="dots"></span>
          <span class="wine-price">${prices}</span>
        </div>
        ${region ? `<div class="wine-region">${region}</div>` : ""}
        ${item.tasting_note ? `<div class="wine-note">${escapeHtml(item.tasting_note)}</div>` : ""}
      </div>`;
  }

  if (template === "modern") {
    return `
      <div class="wine-item">
        <div class="wine-line">
          <span class="wine-name">${name}</span>
          <span class="wine-price">${prices}</span>
        </div>
        <div class="wine-meta">${vintage.trim()}${vintage && region ? " · " : ""}${region}</div>
      </div>`;
  }

  // minimal
  return `
    <div class="wine-item">
      <span class="wine-name">${name}${vintage}</span>
      <span class="wine-price">${prices}</span>
    </div>`;
}

function renderThemeCss(theme: MenuTheme | null | undefined): string {
  if (!theme) return "";
  const spacing = {
    compact: { page: 32, section: 22, item: 8 },
    comfortable: { page: 40, section: 32, item: 12 },
    spacious: { page: 52, section: 42, item: 16 },
  }[theme.spacing.scale];
  return `
  body { font-family: ${fontStack(theme.typography.body)}; color: ${theme.palette.text}; background: ${theme.palette.background}; padding: ${spacing.page}px; }
  h1, .section-title, .wine-name, .wine-note { font-family: ${fontStack(theme.typography.heading)}; }
  .restaurant, .wine-region, .wine-note, .wine-meta { color: ${theme.palette.mutedText}; }
  .section-title { color: ${theme.palette.text}; border-color: ${theme.palette.border}; margin-top: ${spacing.section}px; }
  .wine-item { margin-bottom: ${spacing.item}px; }
  .dots { border-color: ${theme.palette.border}; }
  .footer { color: ${theme.palette.accent}; }`;
}

function themeAttribute(theme: MenuTheme | null | undefined): string {
  return theme ? ` data-menu-theme="${escapeHtml(theme.name)}"` : "";
}

// Font policy (BND-004): PDF templates MUST NOT reach out to any remote
// font CDN. An external font fetch inside puppeteer's networkidle0 wait
// could wedge a worker indefinitely. We use system font stacks so
// rendering is deterministic and offline.

export function renderClassic(data: ListData, theme?: MenuTheme | null): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  @page { margin: 1.25in; size: letter; }
  body { font-family: Georgia, 'Times New Roman', Cambria, serif; color: #1A1A1A; background: #F9F6F0; margin: 0; padding: 40px; line-height: 1.5; }
  h1 { font-size: 28pt; font-weight: 500; margin: 0 0 4px; }
  .restaurant { font-size: 11pt; color: #6B6B6B; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 32px; }
  .section-title { font-size: 24pt; font-weight: 500; margin: 32px 0 16px; padding-bottom: 8px; border-bottom: 1px solid #E5E2DB; }
  .wine-item { margin-bottom: 12px; }
  .wine-line { display: flex; align-items: baseline; gap: 8px; }
  .wine-name { font-size: 11pt; font-weight: 500; }
  .dots { flex: 1; border-bottom: 1px dotted #D4CFC3; margin: 0 4px; min-width: 20px; }
  .wine-price { font-size: 11pt; font-weight: 500; white-space: nowrap; }
  .wine-region { font-size: 9pt; color: #6B6B6B; margin-top: 2px; }
  .wine-note { font-size: 10pt; font-style: italic; color: #6B6B6B; margin-top: 2px; }
  .footer { margin-top: 48px; text-align: center; font-size: 9pt; color: #9A958C; }
${renderThemeCss(theme)}
</style>
</head>
<body${themeAttribute(theme)}>
  <h1>${escapeHtml(data.name)}</h1>
  <div class="restaurant">${escapeHtml(data.restaurantName)}</div>
  ${data.sections.map((s) => `
    <div class="section-title">${escapeHtml(s.name)}</div>
    ${s.items.map((i) => renderItem(i, "classic")).join("")}
  `).join("")}
  <div class="footer">Powered by Terroir</div>
</body>
</html>`;
}

export function renderModern(data: ListData, theme?: MenuTheme | null): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  @page { margin: 0.75in; size: letter; }
  body { font-family: system-ui, -apple-system, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif; color: #1A1A1A; background: #fff; margin: 0; padding: 32px; line-height: 1.4; }
  h1 { font-size: 20pt; font-weight: 700; margin: 0 0 4px; }
  .restaurant { font-size: 9pt; color: #6B6B6B; text-transform: uppercase; letter-spacing: 0.1em; font-weight: 600; margin-bottom: 24px; }
  .section-title { font-size: 12pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; margin: 28px 0 12px; color: #1A1A1A; }
  .wine-item { margin-bottom: 10px; }
  .wine-line { display: flex; justify-content: space-between; align-items: baseline; }
  .wine-name { font-size: 10pt; font-weight: 600; }
  .wine-price { font-size: 10pt; font-weight: 500; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .wine-meta { font-size: 8.5pt; color: #6B6B6B; margin-top: 1px; }
  .footer { margin-top: 40px; text-align: center; font-size: 8pt; color: #9A958C; text-transform: uppercase; letter-spacing: 0.06em; }
${renderThemeCss(theme)}
</style>
</head>
<body${themeAttribute(theme)}>
  <h1>${escapeHtml(data.name)}</h1>
  <div class="restaurant">${escapeHtml(data.restaurantName)}</div>
  ${data.sections.map((s) => `
    <div class="section-title">${escapeHtml(s.name)}</div>
    ${s.items.map((i) => renderItem(i, "modern")).join("")}
  `).join("")}
  <div class="footer">Powered by Terroir</div>
</body>
</html>`;
}

export function renderMinimal(data: ListData, theme?: MenuTheme | null): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  @page { margin: 1.25in; size: letter; }
  body { font-family: Georgia, 'Times New Roman', Cambria, serif; color: #1A1A1A; background: #FAFAF8; margin: 0; padding: 48px; line-height: 1.6; }
  h1 { font-size: 24pt; font-weight: 400; margin: 0 0 48px; text-align: center; }
  .section-spacer { height: 32px; }
  .wine-item { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; font-size: 11pt; }
  .wine-name { font-weight: 400; }
  .wine-price { font-weight: 500; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .footer { margin-top: 64px; text-align: center; font-size: 9pt; color: #9A958C; }
${renderThemeCss(theme)}
</style>
</head>
<body${themeAttribute(theme)}>
  <h1>${escapeHtml(data.name)}</h1>
  ${data.sections.map((s, i) => `
    ${i > 0 ? '<div class="section-spacer"></div>' : ""}
    ${s.items.map((it) => renderItem(it, "minimal")).join("")}
  `).join("")}
  <div class="footer">Powered by Terroir</div>
</body>
</html>`;
}

export function renderTemplate(
  template: string,
  data: ListData,
  theme?: MenuTheme | null,
): string {
  switch (template) {
    case "modern":
      return renderModern(data, theme);
    case "minimal":
      return renderMinimal(data, theme);
    default:
      return renderClassic(data, theme);
  }
}
import { fontStack, type MenuTheme } from "@/lib/branding/theme";
