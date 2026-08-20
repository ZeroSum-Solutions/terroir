import type { MenuTheme } from "@/lib/branding/theme";

export const VALID_THEME: MenuTheme = {
  version: 1,
  name: "Cellar Ink",
  palette: {
    background: "#FFFFFF",
    surface: "#F7F5F2",
    text: "#111111",
    mutedText: "#595959",
    accent: "#721D35",
    border: "#D8D2CA",
  },
  typography: {
    heading: "Cormorant Garamond",
    body: "Inter",
  },
  spacing: { scale: "comfortable" },
};

export const BRAND_PALETTE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAECAYAAACHtL/sAAAAH0lEQVR4nGM4o2T8Hx9WcjmDilelgbGgoCAYMwx9AwCiRoIpFQbb/QAAAABJRU5ErkJggg==",
  "base64",
);
