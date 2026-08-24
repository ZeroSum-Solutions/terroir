import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // P2 (docs/plans/2026-08-23-p2-identity-spine.md §5): the golden-vector
  // contract test in src/domains/identity/normalize.test.ts dynamically
  // imports P1's fixture generator directly from the sibling worktree
  // terroir-vw-p1 (proving byte-for-byte agreement with the LIVE function,
  // not a hand-copied snapshot of it). Vite's dev-server file-serving
  // allowlist defaults to this project's own root and otherwise refuses
  // to load files outside it — widen it to the shared parent directory so
  // that one cross-worktree import resolves. Test/dev tooling only; never
  // shipped.
  server: {
    fs: {
      allow: [path.resolve(__dirname, ".."), path.resolve(__dirname)],
    },
  },
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["./vitest.setup.ts"],
  },
});
