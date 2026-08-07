import { describe, expect, it, vi } from "vitest";
import {
  listSupabaseObjectPaths,
  removeSupabaseObjects,
  createSupabaseSignedUrls,
} from "./supabase-storage";

function storageClient(
  list = vi.fn(),
  remove = vi.fn(),
  createSignedUrls = vi.fn(),
) {
  return {
    storage: {
      from: vi.fn(() => ({ list, remove, createSignedUrls })),
    },
  };
}

describe("Supabase Storage adapter", () => {
  it("lists every tenant object across paginated provider results", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      name: `first-${index}`,
    }));
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        data: firstPage,
        error: null,
      })
      .mockResolvedValueOnce({ data: [{ name: "second.pdf" }], error: null });
    const supabase = storageClient(list);

    const paths = await listSupabaseObjectPaths({
      supabase: supabase as never,
      bucket: "invoice-images",
      prefix: "tenant-id",
    });

    expect(paths).toEqual([
      ...firstPage.map(({ name }) => `tenant-id/${name}`),
      "tenant-id/second.pdf",
    ]);
    expect(list).toHaveBeenCalledWith("tenant-id", {
      limit: 100,
      offset: 0,
      sortBy: { column: "name", order: "asc" },
    });
    expect(list).toHaveBeenLastCalledWith("tenant-id", {
      limit: 100,
      offset: 100,
      sortBy: { column: "name", order: "asc" },
    });
  });

  it("recursively lists legacy nested tenant objects", async () => {
    const list = vi.fn(async (prefix: string) => {
      if (prefix === "tenant-id") {
        return {
          data: [
            { id: null, name: "legacy-wine-id" },
            { id: "flat-object", name: "current.webp" },
          ],
          error: null,
        };
      }
      if (prefix === "tenant-id/legacy-wine-id") {
        return {
          data: [{ id: "nested-object", name: "fixture.webp" }],
          error: null,
        };
      }
      throw new Error(`Unexpected prefix: ${prefix}`);
    });
    const supabase = storageClient(list);

    await expect(
      listSupabaseObjectPaths({
        supabase: supabase as never,
        bucket: "wine-images",
        prefix: "tenant-id",
      }),
    ).resolves.toEqual([
      "tenant-id/legacy-wine-id/fixture.webp",
      "tenant-id/current.webp",
    ]);
  });

  it("paginates nested legacy folders without escaping the tenant prefix", async () => {
    const nestedFirstPage = Array.from({ length: 100 }, (_, index) => ({
      id: `nested-${index}`,
      name: `nested-${index}.webp`,
    }));
    const list = vi.fn(async (prefix: string, options: { offset: number }) => {
      if (prefix === "tenant-id") {
        return {
          data: [{ id: null, name: "legacy-wine-id" }],
          error: null,
        };
      }
      if (prefix === "tenant-id/legacy-wine-id" && options.offset === 0) {
        return { data: nestedFirstPage, error: null };
      }
      if (prefix === "tenant-id/legacy-wine-id" && options.offset === 100) {
        return {
          data: [{ id: "nested-last", name: "last.webp" }],
          error: null,
        };
      }
      throw new Error(`Unexpected list request: ${prefix}/${options.offset}`);
    });
    const supabase = storageClient(list);

    const paths = await listSupabaseObjectPaths({
      supabase: supabase as never,
      bucket: "wine-images",
      prefix: "tenant-id",
    });

    expect(paths).toHaveLength(101);
    expect(paths[0]).toBe("tenant-id/legacy-wine-id/nested-0.webp");
    expect(paths[100]).toBe("tenant-id/legacy-wine-id/last.webp");
  });

  it.each(["", ".", "..", "nested/object", "nested\\object"])(
    "fails closed when the provider returns an invalid object segment %j",
    async (name) => {
      const list = vi.fn().mockResolvedValue({
        data: [{ id: "provider-object", name }],
        error: null,
      });
      const supabase = storageClient(list);

      await expect(
        listSupabaseObjectPaths({
          supabase: supabase as never,
          bucket: "wine-images",
          prefix: "tenant-id",
        }),
      ).rejects.toThrow("Storage object tree contains an invalid path.");
    },
  );

  it("fails closed when a tenant object tree exceeds the entry bound", async () => {
    const fullPage = Array.from({ length: 100 }, (_, index) => ({
      id: `object-${index}`,
      name: `object-${index}.webp`,
    }));
    const list = vi.fn(async (_prefix: string, options: { offset: number }) => ({
      data:
        options.offset < 10_000
          ? fullPage
          : [{ id: "overflow", name: "overflow.webp" }],
      error: null,
    }));
    const supabase = storageClient(list);

    await expect(
      listSupabaseObjectPaths({
        supabase: supabase as never,
        bucket: "wine-images",
        prefix: "tenant-id",
      }),
    ).rejects.toThrow("Storage object tree exceeds cleanup limits.");
    expect(list).toHaveBeenCalledTimes(101);
  });

  it("fails closed when a legacy object tree exceeds the depth bound", async () => {
    const list = vi.fn(async (_prefix: string) => ({
      data: [{ id: null, name: "nested" }],
      error: null,
    }));
    const supabase = storageClient(list);

    await expect(
      listSupabaseObjectPaths({
        supabase: supabase as never,
        bucket: "wine-images",
        prefix: "tenant-id",
      }),
    ).rejects.toThrow("Storage object tree exceeds cleanup limits.");
    expect(list).toHaveBeenCalledTimes(9);
  });

  it("batches image URL signing and keeps only provider-approved URLs", async () => {
    const paths = Array.from({ length: 101 }, (_, index) => "tenant/" + index);
    const createSignedUrls = vi
      .fn()
      .mockResolvedValueOnce({
        data: paths.slice(0, 100).map((path) => ({
          path,
          signedUrl: "https://signed.example/" + path,
        })),
        error: null,
      })
      .mockResolvedValueOnce({
        data: [{ path: paths[100], signedUrl: null }],
        error: null,
      });
    const supabase = storageClient(vi.fn(), vi.fn(), createSignedUrls);

    const signedUrls = await createSupabaseSignedUrls({
      supabase: supabase as never,
      bucket: "wine-images",
      paths,
      expiresInSeconds: 300,
    });

    expect(createSignedUrls).toHaveBeenNthCalledWith(
      1,
      paths.slice(0, 100),
      300,
    );
    expect(createSignedUrls).toHaveBeenNthCalledWith(2, paths.slice(100), 300);
    expect(signedUrls.size).toBe(100);
    expect(signedUrls.get(paths[0]!)).toBe(
      "https://signed.example/" + paths[0],
    );
    expect(signedUrls.has(paths[100]!)).toBe(false);
  });

  it("batches large removal requests without skipping an object", async () => {
    const remove = vi.fn().mockResolvedValue({ data: [], error: null });
    const supabase = storageClient(vi.fn(), remove);
    const paths = Array.from({ length: 201 }, (_, index) => `tenant/${index}`);

    await removeSupabaseObjects({
      supabase: supabase as never,
      bucket: "wine-images",
      paths,
    });

    expect(remove).toHaveBeenCalledTimes(3);
    expect(remove.mock.calls.map(([batch]) => batch.length)).toEqual([
      100,
      100,
      1,
    ]);
    expect(remove.mock.calls[2]?.[0]).toEqual(["tenant/200"]);
  });
});
