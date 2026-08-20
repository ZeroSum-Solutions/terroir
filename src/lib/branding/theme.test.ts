import { describe, expect, it } from "vitest";
import {
  MenuThemeProposalsSchema,
  MenuThemeSchema,
  contrastRatio,
  parseRenderableTheme,
  parseStoredTheme,
  themeCssVariables,
  validateThemeContrast,
} from "./theme";
import { VALID_THEME } from "@/test/fixtures/menu-theme";

describe("MenuThemeSchema", () => {
  it("accepts a complete structured theme", () => {
    expect(MenuThemeSchema.parse(VALID_THEME)).toEqual(VALID_THEME);
  });

  it("rejects raw CSS at every theme boundary", () => {
    expect(
      MenuThemeSchema.safeParse({
        ...VALID_THEME,
        rawCss: "body { display: none }",
      }).success,
    ).toBe(false);
    expect(
      MenuThemeSchema.safeParse({
        ...VALID_THEME,
        palette: { ...VALID_THEME.palette, background: "var(--evil)" },
      }).success,
    ).toBe(false);
  });

  it("rejects fonts outside the curated allowlist", () => {
    expect(
      MenuThemeSchema.safeParse({
        ...VALID_THEME,
        typography: { ...VALID_THEME.typography, heading: "Comic Sans MS" },
      }).success,
    ).toBe(false);
  });
});

describe("MenuThemeProposalsSchema", () => {
  it("requires proposal names to be unique across the collection", () => {
    expect(
      MenuThemeProposalsSchema.safeParse([
        VALID_THEME,
        { ...VALID_THEME },
        { ...VALID_THEME, name: "Night Service" },
      ]).success,
    ).toBe(false);
  });
});

describe("WCAG contrast", () => {
  it("matches known contrast pairs", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 4);
    expect(contrastRatio("#777777", "#FFFFFF")).toBeCloseTo(4.478, 3);
    expect(contrastRatio("#767676", "#FFFFFF")).toBeCloseTo(4.542, 3);
  });

  it("names each failing role pair with its measured ratio", () => {
    const failures = validateThemeContrast({
      ...VALID_THEME,
      palette: {
        ...VALID_THEME.palette,
        text: "#777777",
        mutedText: "#AAAAAA",
      },
    });

    expect(failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pair: "palette.text on palette.background" }),
        expect.objectContaining({ pair: "palette.mutedText on palette.background" }),
      ]),
    );
  });
});

describe("theme rendering tokens", () => {
  it("preserves the current appearance when the stored theme is null or invalid", () => {
    expect(parseStoredTheme(null)).toBeNull();
    expect(parseStoredTheme({ rawCss: "body{}" })).toBeNull();
    expect(themeCssVariables(null)).toBeUndefined();
  });

  it("rejects a structurally valid low-contrast theme at the render boundary", () => {
    const lowContrastTheme = {
      ...VALID_THEME,
      palette: {
        ...VALID_THEME.palette,
        text: "#777777",
        mutedText: "#AAAAAA",
        accent: "#BBBBBB",
      },
    };

    expect(MenuThemeSchema.safeParse(lowContrastTheme).success).toBe(true);
    expect(parseStoredTheme(lowContrastTheme)).not.toBeNull();
    expect(parseRenderableTheme(lowContrastTheme)).toBeNull();
  });

  it("maps a valid stored theme to scoped web tokens", () => {
    expect(themeCssVariables(VALID_THEME)).toMatchObject({
      "--color-surface": "#FFFFFF",
      "--color-surface-muted": "#F7F5F2",
      "--color-ink": "#111111",
      "--color-accent": "#721D35",
      "--font-serif": expect.stringContaining("Cormorant Garamond"),
      "--font-sans": expect.stringContaining("Inter"),
    });
  });
});
