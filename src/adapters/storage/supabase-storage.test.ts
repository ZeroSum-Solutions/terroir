// Contract tests for the Supabase storage adapter — §3.4 of the refactor plan.
//
// This module is mocked wholesale at every call site, so before this file
// existed none of its error mapping ran anywhere in the suite. That matters
// most for the branches that are NOT simple pass-throughs: the missing-URL
// case that has no `error` to key off, and getSupabasePublicUrl's silent
// empty-string fallback.
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import {
  SupabaseStorageError,
  createSupabaseSignedUrl,
  getSupabasePublicUrl,
  removeSupabaseObjects,
  uploadSupabaseObject,
} from "./supabase-storage";

type StorageStub = {
  createSignedUrl: ReturnType<typeof vi.fn>;
  upload: ReturnType<typeof vi.fn>;
  getPublicUrl: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
};

function clientWith(stub: Partial<StorageStub>) {
  const from = vi.fn(() => stub);
  return {
    client: { storage: { from } } as unknown as SupabaseClient<Database>,
    from,
  };
}

describe("SupabaseStorageError", () => {
  it("carries its own name and preserves the underlying cause", () => {
    const cause = new Error("boom");
    const err = new SupabaseStorageError("wrapped", { cause });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("SupabaseStorageError");
    expect(err.cause).toBe(cause);
  });
});

describe("createSupabaseSignedUrl", () => {
  it("returns the signed URL and passes the bucket, path and expiry through", async () => {
    const createSignedUrl = vi.fn().mockResolvedValue({ data: { signedUrl: "https://signed.example/x" }, error: null });
    const { client, from } = clientWith({ createSignedUrl });

    const url = await createSupabaseSignedUrl({ supabase: client, bucket: "invoices", path: "a/b.pdf", expiresInSeconds: 120 });

    expect(url).toBe("https://signed.example/x");
    expect(from).toHaveBeenCalledWith("invoices");
    expect(createSignedUrl).toHaveBeenCalledWith("a/b.pdf", 120);
  });

  it("wraps a returned error as SupabaseStorageError and keeps it as the cause", async () => {
    const cause = { message: "object not found" };
    const createSignedUrl = vi.fn().mockResolvedValue({ data: null, error: cause });
    const { client } = clientWith({ createSignedUrl });

    await expect(
      createSupabaseSignedUrl({ supabase: client, bucket: "b", path: "p", expiresInSeconds: 60 }),
    ).rejects.toThrow(SupabaseStorageError);

    await createSupabaseSignedUrl({ supabase: client, bucket: "b", path: "p", expiresInSeconds: 60 }).catch(
      (e: SupabaseStorageError) => expect(e.cause).toBe(cause),
    );
  });

  it("throws when the call reports success but returns no URL", async () => {
    // The branch with nothing to key off: error is null, so only the
    // explicit !data?.signedUrl guard stands between the caller and
    // `undefined` being handed back as a URL.
    const createSignedUrl = vi.fn().mockResolvedValue({ data: {}, error: null });
    const { client } = clientWith({ createSignedUrl });

    await expect(
      createSupabaseSignedUrl({ supabase: client, bucket: "b", path: "p", expiresInSeconds: 60 }),
    ).rejects.toThrow(SupabaseStorageError);
  });
});

describe("uploadSupabaseObject", () => {
  it("defaults upsert to false rather than leaving it undefined", async () => {
    const upload = vi.fn().mockResolvedValue({ error: null });
    const { client } = clientWith({ upload });
    const body = Buffer.from("pdf");

    await uploadSupabaseObject({ supabase: client, bucket: "b", path: "p.pdf", body, contentType: "application/pdf" });

    expect(upload).toHaveBeenCalledWith("p.pdf", body, { contentType: "application/pdf", upsert: false });
  });

  it("honours an explicit upsert", async () => {
    const upload = vi.fn().mockResolvedValue({ error: null });
    const { client } = clientWith({ upload });

    await uploadSupabaseObject({
      supabase: client, bucket: "b", path: "p.pdf", body: Buffer.from(""), contentType: "application/pdf", upsert: true,
    });

    expect(upload).toHaveBeenCalledWith("p.pdf", expect.anything(), { contentType: "application/pdf", upsert: true });
  });

  it("wraps an upload error", async () => {
    const upload = vi.fn().mockResolvedValue({ error: { message: "quota" } });
    const { client } = clientWith({ upload });

    await expect(
      uploadSupabaseObject({ supabase: client, bucket: "b", path: "p", body: Buffer.from(""), contentType: "text/plain" }),
    ).rejects.toThrow(SupabaseStorageError);
  });
});

describe("getSupabasePublicUrl", () => {
  it("returns the public URL", () => {
    const getPublicUrl = vi.fn().mockReturnValue({ data: { publicUrl: "https://pub.example/x" } });
    const { client } = clientWith({ getPublicUrl });

    expect(getSupabasePublicUrl({ supabase: client, bucket: "b", path: "p" })).toBe("https://pub.example/x");
  });

  it("returns an empty string rather than throwing when no URL comes back", () => {
    // Pinning this deliberately: unlike its three siblings this function
    // swallows failure and hands back "". A caller that renders the result
    // into an <img src> gets a broken image, not an error. Documented here
    // as the current contract so a change to it is a visible test change.
    const getPublicUrl = vi.fn().mockReturnValue({ data: null });
    const { client } = clientWith({ getPublicUrl });

    expect(getSupabasePublicUrl({ supabase: client, bucket: "b", path: "p" })).toBe("");
  });
});

describe("removeSupabaseObjects", () => {
  it("passes the whole path list in one call", async () => {
    const remove = vi.fn().mockResolvedValue({ error: null });
    const { client } = clientWith({ remove });

    await removeSupabaseObjects({ supabase: client, bucket: "b", paths: ["a", "b", "c"] });

    expect(remove).toHaveBeenCalledWith(["a", "b", "c"]);
  });

  it("wraps a removal error", async () => {
    const remove = vi.fn().mockResolvedValue({ error: { message: "denied" } });
    const { client } = clientWith({ remove });

    await expect(removeSupabaseObjects({ supabase: client, bucket: "b", paths: ["a"] })).rejects.toThrow(
      SupabaseStorageError,
    );
  });
});
