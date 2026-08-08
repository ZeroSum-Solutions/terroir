import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/0077_wine_list_pdf_artifacts.sql",
  "utf8",
);
const rollback = readFileSync(
  "supabase/migrations/down/0077_wine_list_pdf_artifacts.down.sql",
  "utf8",
);
const route = readFileSync("src/app/api/pdf/route.ts", "utf8");
const handler = readFileSync("src/worker/wine-list-pdf-handler.ts", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  scripts: Record<string, string>;
};
const railpackConfig = JSON.parse(readFileSync("railpack.json", "utf8")) as {
  buildAptPackages: string[];
  deploy: {
    aptPackages: string[];
    variables: Record<string, string>;
  };
};
const puppeteerConfig = readFileSync(".puppeteerrc.cjs", "utf8");
const webManifest = readFileSync("railway.toml", "utf8");
const workerManifest = readFileSync("railway.worker.toml", "utf8");
const browserValidator = readFileSync(
  "scripts/validate-worker-browser.mjs",
  "utf8",
);
const client = readFileSync(
  "src/app/(app)/lists/[id]/wine-list-editor.tsx",
  "utf8",
);
const normalizedMigration = migration.toLowerCase().replace(/\s+/g, " ");
const normalizedRollback = rollback.toLowerCase().replace(/\s+/g, " ");

describe("TER-021E PDF worker contract", () => {
  it("keeps enqueueing behind a default-safe rollback flag", () => {
    expect(route).toContain("isPdfWorkerEnabled()");
    expect(route.indexOf("isPdfWorkerEnabled()")).toBeLessThan(
      route.indexOf("enqueueWineListPdfJob({"),
    );
    expect(rollback).toContain("Disable PDF_WORKER_ENABLED");
    expect(normalizedRollback).not.toContain("public = true");
    expect(normalizedRollback).not.toContain("public=true");
  });

  it("registers a durable idempotent handler before enabling the caller", () => {
    expect(handler).toContain('job.job_type !== "wine_list_pdf"');
    expect(handler).toContain('job.subject_table !== "wine_lists"');
    expect(handler).toContain('bucket: "generated-exports"');
    expect(handler).toContain("upsert: true");
    expect(client).toContain("createIdempotentCommandStore");
    expect(client).toContain("waitForQueuedPdf");
  });

  it("installs and verifies the system browser in build and runtime images", () => {
    expect(packageJson.scripts["worker:install-browser"]).toBeUndefined();
    expect(workerManifest).not.toContain("pnpm worker:install-browser");
    expect(workerManifest).toContain("pnpm validate:worker-browser");
    expect(webManifest).not.toContain("pnpm worker:install-browser");
    expect(webManifest).toContain("pnpm validate:worker-browser");
    expect(railpackConfig.buildAptPackages).toContain("chromium");
    expect(railpackConfig.deploy.aptPackages).toContain("chromium");
    expect(railpackConfig.deploy.variables.PUPPETEER_EXECUTABLE_PATH).toBe(
      "/usr/bin/chromium",
    );
    expect(puppeteerConfig).toContain("chrome: { skipDownload: true }");
    expect(puppeteerConfig).toContain(
      '"chrome-headless-shell": { skipDownload: true }',
    );
    expect(browserValidator).toContain('process.platform === "linux"');
    expect(browserValidator).toContain('"/usr/bin/chromium"');
    expect(browserValidator).toContain("constants.X_OK");
    expect(browserValidator).toContain("puppeteer.launch({");
    expect(browserValidator).toContain("headless: true");
    expect(browserValidator).toContain('"--no-sandbox"');
    expect(browserValidator).toContain('"--disable-setuid-sandbox"');
    expect(browserValidator).toContain("worker-browser-ready");
  });

  it("keeps artifacts private, bounded, and tenant-readable only", () => {
    expect(migration).toContain("'generated-exports'");
    expect(migration).toContain("public = false");
    expect(migration).toContain("array['application/pdf']");
    expect(migration).toContain("wine_list_pdf_artifact_tenant_id(name)");
    expect(migration).toContain("public.is_member(");
    expect(normalizedMigration).not.toContain("for insert to authenticated");
    expect(normalizedMigration).not.toContain("for update to authenticated");
  });
});
