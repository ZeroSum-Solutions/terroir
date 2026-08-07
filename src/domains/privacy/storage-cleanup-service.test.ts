import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  listSupabaseObjectPaths,
  removeSupabaseObjects,
  SupabaseStorageError,
} from "@/adapters/storage";
import {
  PrivacyStorageCleanupError,
  removeTenantStorageObjects,
} from "./storage-cleanup-service";

vi.mock("@/adapters/storage", () => ({
  listSupabaseObjectPaths: vi.fn(),
  removeSupabaseObjects: vi.fn(),
  SupabaseStorageError: class SupabaseStorageError extends Error {},
}));

describe("tenant storage cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists and removes every governed bucket before tenant deletion", async () => {
    vi.mocked(listSupabaseObjectPaths)
      .mockResolvedValueOnce(["tenant-id/invoice.png"])
      .mockResolvedValueOnce(["tenant-id/wine.webp"]);
    vi.mocked(removeSupabaseObjects).mockResolvedValue();

    await removeTenantStorageObjects({
      supabase: {} as never,
      restaurantId: "tenant-id",
    });

    expect(listSupabaseObjectPaths).toHaveBeenNthCalledWith(1, {
      supabase: {},
      bucket: "invoice-images",
      prefix: "tenant-id",
    });
    expect(listSupabaseObjectPaths).toHaveBeenNthCalledWith(2, {
      supabase: {},
      bucket: "wine-images",
      prefix: "tenant-id",
    });
    expect(removeSupabaseObjects).toHaveBeenNthCalledWith(1, {
      supabase: {},
      bucket: "invoice-images",
      paths: ["tenant-id/invoice.png"],
    });
    expect(removeSupabaseObjects).toHaveBeenNthCalledWith(2, {
      supabase: {},
      bucket: "wine-images",
      paths: ["tenant-id/wine.webp"],
    });
  });

  it("fails closed without starting later buckets when listing fails", async () => {
    vi.mocked(listSupabaseObjectPaths).mockRejectedValue(
      new SupabaseStorageError("Failed to list objects."),
    );

    await expect(
      removeTenantStorageObjects({
        supabase: {} as never,
        restaurantId: "tenant-id",
      }),
    ).rejects.toBeInstanceOf(PrivacyStorageCleanupError);

    expect(listSupabaseObjectPaths).toHaveBeenCalledTimes(1);
    expect(removeSupabaseObjects).not.toHaveBeenCalled();
  });
});
