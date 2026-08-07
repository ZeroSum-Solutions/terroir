import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/0075_privacy_storage_lifecycle.sql",
  "utf8",
);
const rollback = readFileSync(
  "supabase/migrations/down/0075_privacy_storage_lifecycle.down.sql",
  "utf8",
);
const bucketRepair = readFileSync(
  "supabase/migrations/0076_private_media_bucket_provisioning.sql",
  "utf8",
);
const bucketRepairRollback = readFileSync(
  "supabase/migrations/down/0076_private_media_bucket_provisioning.down.sql",
  "utf8",
);
const restaurantDeleteDependents = readFileSync(
  "supabase/migrations/0079_restaurant_delete_dependents.sql",
  "utf8",
);
const restaurantDeleteDependentsRollback = readFileSync(
  "supabase/migrations/down/0079_restaurant_delete_dependents.down.sql",
  "utf8",
);
const runbook = readFileSync("docs/runbooks/data-lifecycle-privacy.md", "utf8");
const restaurantRoute = readFileSync(
  "src/app/api/restaurant/[id]/route.ts",
  "utf8",
);
const cellarRoute = readFileSync("src/app/api/cellar/[id]/route.ts", "utf8");
const wineImages = readFileSync(
  "src/domains/cellar/wine-image-service.ts",
  "utf8",
);
const scanImages = readFileSync(
  "src/domains/scanning/scan-image-service.ts",
  "utf8",
);
const saveScanRoute = readFileSync(
  "src/app/api/inventory/save-scan/route.ts",
  "utf8",
);

describe("TER-024 privacy lifecycle contracts", () => {
  it("makes both image buckets private and validates new object owners", () => {
    expect(migration).toContain("set public = false");
    expect(migration).toContain("file_size_limit = 10485760");
    expect(migration).toContain("public.is_valid_invoice_image_path(name)");
    expect(migration).toContain("public.is_valid_wine_image_path(name)");
    expect(migration).toContain("public.storage_tenant_prefix_id(name)");
    expect(migration).toContain("create policy \"members can read wine images\"");
    expect(bucketRepair).toContain("'invoice-images'");
    expect(bucketRepair).toContain("'wine-images'");
    expect(bucketRepair).toContain("on conflict (id) do update");
    expect(bucketRepair).toContain("public = false");
  });

  it("keeps user deletion from retaining application attribution identifiers", () => {
    for (const constraint of [
      "invitations_invited_by_fkey",
      "invoice_scans_created_by_fkey",
      "wines_eightysixed_by_fkey",
      "availability_events_user_id_fkey",
      "open_bottles_opened_by_fkey",
      "pour_events_actor_user_id_fkey",
    ]) {
      expect(migration).toContain(
        `add constraint ${constraint}\n    foreign key`,
      );
    }
    expect(migration.match(/on delete set null/g)).toHaveLength(6);
  });

  it("uses five-minute signed URLs and never creates a public wine URL", () => {
    expect(wineImages).toContain("const SIGNED_URL_TTL_SECONDS = 300");
    expect(scanImages).toContain("const SIGNED_URL_TTL_SECONDS = 300");
    expect(wineImages).toContain("createSupabaseSignedUrl");
    expect(wineImages).toContain("createSupabaseSignedUrls");
    expect(wineImages).not.toContain("getSupabasePublicUrl");
    expect(wineImages).toContain(".update({ hero_image_url: storagePath })");
  });

  it("removes governed Storage objects at both supported deletion boundaries", () => {
    expect(restaurantRoute).toContain("removeTenantStorageObjects");
    expect(restaurantRoute).toContain("Failed to remove restaurant storage.");
    expect(cellarRoute).toContain("removeWineImageObjects");
    expect(cellarRoute).toContain("requiresWineImageCleanup(result)");
  });

  it("orders restrictive tenant rows ahead of the restaurant cascade", () => {
    expect(restaurantDeleteDependents).toContain(
      "create or replace function public.prepare_restaurant_deletion()",
    );
    expect(restaurantDeleteDependents).toContain(
      "before delete on public.restaurants",
    );
    expect(restaurantDeleteDependents).toContain(
      "delete from public.pour_events",
    );
    expect(restaurantDeleteDependents).toContain(
      "delete from public.wine_list_items",
    );
    expect(restaurantDeleteDependents).toContain(
      "delete from public.inventory_items",
    );
    expect(restaurantDeleteDependentsRollback).toContain(
      "no executable reverse",
    );
    expect(restaurantDeleteDependentsRollback).not.toContain("drop trigger");
  });

  it("documents ownership, retention, provider limits, and fail-closed rollback", () => {
    for (const heading of [
      "## Data map and defaults",
      "## Approved deletion procedure",
      "## Rollback boundary",
    ]) {
      expect(runbook).toContain(heading);
    }
    expect(runbook).toContain("Provider-configured");
    expect(rollback).toContain("no executable reverse");
    expect(rollback).not.toContain("public = true");
    expect(rollback).not.toContain("delete from storage.objects");
    expect(bucketRepairRollback).not.toContain("public = true");
    expect(bucketRepairRollback).not.toContain("delete from storage.buckets");
  });

  it("does not interpolate storage provider errors into scanner or wine-image logs", () => {
    for (const source of [wineImages, scanImages]) {
      expect(source).not.toMatch(
        /console\.error\([^)]*,\s*(?:error|err|.*\.cause)/,
      );
    }
    expect(saveScanRoute).not.toContain(
      'console.error("Invoice image upload failed:", uploadError)',
    );
    expect(saveScanRoute).not.toContain(
      'console.error("Invoice image upload error:", err)',
    );
  });
});
