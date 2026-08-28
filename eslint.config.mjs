import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import jsxA11y from "eslint-plugin-jsx-a11y";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // eslint-config-next already registers the "jsx-a11y" plugin itself
    // (with a handful of its rules on), so re-declaring the plugin via
    // jsxA11y.flatConfigs.recommended errors with "Cannot redefine plugin".
    // Layer just the plugin's recommended rules on top instead.
    rules: jsxA11y.flatConfigs.recommended.rules,
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Every autoFocus in this codebase moves focus into a field the
      // user just explicitly revealed (a dialog opened via useFocusTrap,
      // an inline edit, a search overlay) — the ARIA APG-recommended
      // pattern, not autofocus-on-page-load. Verified by audit, 2026-08.
      "jsx-a11y/no-autofocus": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
