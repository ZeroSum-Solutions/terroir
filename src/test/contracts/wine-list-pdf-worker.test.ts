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
const client = readFileSync(
  "src/app/(app)/lists/[id]/wine-list-editor.tsx",
  "utf8",
);

describe("TER-021E PDF worker contract", () => {
  it("keeps enqueueing behind a default-safe rollback flag", () => {
    expect(route).toContain("isPdfWorkerEnabled()");
    expect(route.indexOf("isPdfWorkerEnabled()")).toBeLessThan(
      route.indexOf("enqueueWineListPdfJob({"),
    );
    expect(rollback).toContain("Disable PDF_WORKER_ENABLED");
    expect(rollback).not.toContain("public = true");
  });

  it("registers a durable idempotent handler before enabling the caller", () => {
    expect(handler).toContain('job.job_type !== "wine_list_pdf"');
    expect(handler).toContain('job.subject_table !== "wine_lists"');
    expect(handler).toContain('bucket: "generated-exports"');
    expect(handler).toContain("upsert: true");
    expect(client).toContain("createIdempotentCommandStore");
    expect(client).toContain("waitForQueuedPdf");
  });

  it("keeps artifacts private, bounded, and tenant-readable only", () => {
    expect(migration).toContain("'generated-exports'");
    expect(migration).toContain("public = false");
    expect(migration).toContain("array['application/pdf']");
    expect(migration).toContain("wine_list_pdf_artifact_tenant_id(name)");
    expect(migration).toContain("public.is_member(");
    expect(migration).not.toContain("for insert to authenticated");
    expect(migration).not.toContain("for update to authenticated");
  });
});
