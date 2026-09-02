import type { CSSProperties } from "react";
import { z } from "zod";

const HexColorSchema = z
  .string()
  .regex(/^#[0-9a-f]{6}$/i, "Expected a six-digit hex colour.")
  // `.overwrite`, not `.transform`: the SDK turns this schema into a JSON
  // Schema for structured output, and a transform is unrepresentable there
  // (it threw before any request went out). Overwrite keeps the type and
  // still upper-cases on parse — see theme-output-format.test.ts.
  .overwrite((value) => value.toUpperCase());

export const GOOGLE_FONT_ALLOWLIST = [
  "Cormorant Garamond",
  "Inter",
  "Libre Baskerville",
  "Lora",
  "Montserrat",
  "Playfair Display",
  "Source Sans 3",
] as const;

const FontSchema = z.enum(GOOGLE_FONT_ALLOWLIST);

export const BrandKitPaletteSchema = z.strictObject({
  colors: z.array(HexColorSchema).min(1).max(6),
});

export const MenuThemeSchema = z.strictObject({
  version: z.literal(1),
  name: z.string().trim().min(1).max(80),
  palette: z.strictObject({
    background: HexColorSchema,
    surface: HexColorSchema,
    text: HexColorSchema,
    mutedText: HexColorSchema,
    accent: HexColorSchema,
    border: HexColorSchema,
  }),
  typography: z.strictObject({
    heading: FontSchema,
    body: FontSchema,
  }),
  spacing: z.strictObject({
    scale: z.enum(["compact", "comfortable", "spacious"]),
  }),
});

export const MenuThemeProposalsSchema = z
  .array(MenuThemeSchema)
  .min(3)
  .max(4)
  .superRefine((themes, context) => {
    const names = new Set<string>();
    themes.forEach((theme, index) => {
      const name = theme.name.toLocaleLowerCase();
      if (names.has(name)) {
        context.addIssue({
          code: "custom",
          message: "Theme names must be unique.",
          path: [index, "name"],
        });
      }
      names.add(name);
    });
  });

export const MenuThemeCollectionSchema = z.strictObject({
  themes: MenuThemeProposalsSchema,
});

export type BrandKitPalette = z.infer<typeof BrandKitPaletteSchema>;
export type MenuTheme = z.infer<typeof MenuThemeSchema>;

export type ContrastFailure = {
  pair: string;
  ratio: number;
  required: number;
};

const FONT_STACKS: Record<(typeof GOOGLE_FONT_ALLOWLIST)[number], string> = {
  "Cormorant Garamond": "'Cormorant Garamond', Georgia, serif",
  Inter: "Inter, Arial, sans-serif",
  "Libre Baskerville": "'Libre Baskerville', Georgia, serif",
  Lora: "Lora, Georgia, serif",
  Montserrat: "Montserrat, Arial, sans-serif",
  "Playfair Display": "'Playfair Display', Georgia, serif",
  "Source Sans 3": "'Source Sans 3', Arial, sans-serif",
};

const SPACING = {
  compact: { sm: "6px", md: "12px", lg: "18px", xl: "24px", xxl: "36px", xxxl: "48px" },
  comfortable: { sm: "8px", md: "16px", lg: "24px", xl: "32px", xxl: "48px", xxxl: "64px" },
  spacious: { sm: "10px", md: "20px", lg: "30px", xl: "40px", xxl: "56px", xxxl: "72px" },
} as const;

type ThemeCssProperties = CSSProperties & Record<`--${string}`, string>;

export function parseStoredTheme(value: unknown): MenuTheme | null {
  const parsed = MenuThemeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseRenderableTheme(value: unknown): MenuTheme | null {
  const theme = parseStoredTheme(value);
  return theme && validateThemeContrast(theme).length === 0 ? theme : null;
}

export function parseStoredProposals(value: unknown): MenuTheme[] {
  const parsed = MenuThemeProposalsSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

export function fontStack(font: MenuTheme["typography"]["heading"]): string {
  return FONT_STACKS[font];
}

export function themeCssVariables(value: unknown): ThemeCssProperties | undefined {
  const theme = parseStoredTheme(value);
  if (!theme) return undefined;
  const spacing = SPACING[theme.spacing.scale];
  return {
    "--color-surface": theme.palette.background,
    "--color-surface-muted": theme.palette.surface,
    "--color-surface-sunken": theme.palette.surface,
    "--color-ink": theme.palette.text,
    "--color-ink-muted": theme.palette.mutedText,
    "--color-ink-subtle": theme.palette.mutedText,
    "--color-accent": theme.palette.accent,
    "--color-border": theme.palette.border,
    "--color-border-strong": theme.palette.border,
    "--font-serif": fontStack(theme.typography.heading),
    "--font-sans": fontStack(theme.typography.body),
    "--spacing-sm": spacing.sm,
    "--spacing-md": spacing.md,
    "--spacing-lg": spacing.lg,
    "--spacing-xl": spacing.xl,
    "--spacing-2xl": spacing.xxl,
    "--spacing-3xl": spacing.xxxl,
  };
}

export function contrastRatio(foreground: string, background: string): number {
  const light = relativeLuminance(foreground);
  const dark = relativeLuminance(background);
  return (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05);
}

export function validateThemeContrast(theme: MenuTheme): ContrastFailure[] {
  const pairs = [
    ["palette.text on palette.background", theme.palette.text, theme.palette.background],
    ["palette.mutedText on palette.background", theme.palette.mutedText, theme.palette.background],
    ["palette.text on palette.surface", theme.palette.text, theme.palette.surface],
    ["palette.mutedText on palette.surface", theme.palette.mutedText, theme.palette.surface],
    ["palette.accent on palette.background", theme.palette.accent, theme.palette.background],
  ] as const;

  return pairs.flatMap(([pair, foreground, background]) => {
    const ratio = contrastRatio(foreground, background);
    return ratio < 4.5 ? [{ pair, ratio, required: 4.5 }] : [];
  });
}

function relativeLuminance(hex: string): number {
  const [red, green, blue] = [1, 3, 5].map((start) =>
    Number.parseInt(hex.slice(start, start + 2), 16) / 255,
  );
  const linear = [red, green, blue].map((channel) =>
    channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}
