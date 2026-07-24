import { describe, expect, it, vi } from "vitest";
import {
  createIdempotentCommandStore,
  IdempotentCommandBusyError,
  IdempotentResponseParseError,
  type IdempotentCommandPersistence,
} from "./idempotency-client";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function keyAt(
  mock: ReturnType<typeof vi.fn>,
  call: number,
): string {
  const init = mock.mock.calls[call][1] as RequestInit;
  return new Headers(init.headers).get("Idempotency-Key") ?? "";
}

function memoryPersistence(): IdempotentCommandPersistence & {
  values: Map<string, { signatureHash: string; key: string }>;
} {
  const values = new Map<
    string,
    { signatureHash: string; key: string }
  >();
  return {
    values,
    load(slot, signatureHash) {
      const value = values.get(slot);
      return value?.signatureHash === signatureHash ? value.key : null;
    },
    save(slot, signatureHash, key) {
      values.set(slot, { signatureHash, key });
    },
    clear(slot) {
      values.delete(slot);
    },
  };
}

describe("idempotent command store", () => {
  it("reuses the exact key and frozen JSON after a transient response", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(503, {
          error: { code: "idempotency_unavailable", message: "Wait." },
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const commands = createIdempotentCommandStore({
      fetchImpl,
    });
    const command = {
      slot: "wine:update",
      url: "/api/wines/wine-a",
      method: "PATCH" as const,
      json: { price: 22 },
    };

    expect((await commands.json(command)).response.status).toBe(503);
    expect((await commands.json(command)).response.status).toBe(200);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(keyAt(fetchImpl, 0)).toBe(keyAt(fetchImpl, 1));
    expect((fetchImpl.mock.calls[0][1] as RequestInit).body).toBe(
      JSON.stringify(command.json),
    );
    expect((fetchImpl.mock.calls[1][1] as RequestInit).body).toBe(
      JSON.stringify(command.json),
    );
  });

  it("retains a key after network rejection and AbortError", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network interrupted"))
      .mockRejectedValueOnce(
        new DOMException("request aborted", "AbortError"),
      )
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const commands = createIdempotentCommandStore({ fetchImpl });
    const command = {
      slot: "wine:delete",
      url: "/api/cellar/wine-a",
      method: "DELETE" as const,
    };

    await expect(commands.json(command)).rejects.toThrow(
      "network interrupted",
    );
    await expect(commands.json(command)).rejects.toMatchObject({
      name: "AbortError",
    });
    await commands.json(command);

    expect(keyAt(fetchImpl, 0)).toBe(keyAt(fetchImpl, 1));
    expect(keyAt(fetchImpl, 1)).toBe(keyAt(fetchImpl, 2));
  });

  it("clears after deterministic failures and parsed success", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(400, {
          error: { code: "validation_error", message: "Invalid." },
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const commands = createIdempotentCommandStore({ fetchImpl });
    const command = {
      slot: "config:update",
      url: "/api/cellar/config",
      method: "PATCH" as const,
      json: { rows: 5 },
    };

    await commands.json(command);
    await commands.json(command);
    await commands.json(command);

    expect(keyAt(fetchImpl, 0)).not.toBe(keyAt(fetchImpl, 1));
    expect(keyAt(fetchImpl, 1)).not.toBe(keyAt(fetchImpl, 2));
  });

  it("clears an auth rejection before a post-login retry", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(401, {
          error: { code: "unauthorized", message: "Sign in." },
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const commands = createIdempotentCommandStore({ fetchImpl });
    const command = {
      slot: "invite:accept",
      url: "/api/team/accept-invite",
      method: "POST" as const,
      json: { token: "invite-token" },
    };

    await commands.json(command);
    await commands.json(command);

    expect(keyAt(fetchImpl, 0)).not.toBe(keyAt(fetchImpl, 1));
  });

  it("retains a key when a successful JSON response is interrupted", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("{", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const commands = createIdempotentCommandStore({ fetchImpl });
    const command = {
      slot: "team:invite",
      url: "/api/team/invite",
      method: "POST" as const,
      json: { email: "person@example.test", role: "staff" },
    };

    await expect(commands.json(command)).rejects.toBeInstanceOf(
      IdempotentResponseParseError,
    );
    await commands.json(command);

    expect(keyAt(fetchImpl, 0)).toBe(keyAt(fetchImpl, 1));
  });

  it("coalesces the same in-flight command to one fetch", async () => {
    let resolveFetch: ((value: Response) => void) | undefined;
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const commands = createIdempotentCommandStore({ fetchImpl });
    const command = {
      slot: "section:update",
      url: "/api/cellar/wine-a/section",
      method: "PATCH" as const,
      json: { section: "Rack A" },
    };

    const first = commands.json(command);
    const second = commands.json(command);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    resolveFetch?.(jsonResponse(200, { ok: true }));

    await expect(first).resolves.toMatchObject({
      data: { ok: true },
    });
    await expect(second).resolves.toMatchObject({
      data: { ok: true },
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects a changed request in one active slot without corrupting it", async () => {
    let resolveFetch: ((value: Response) => void) | undefined;
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const commands = createIdempotentCommandStore({ fetchImpl });
    const first = commands.json({
      slot: "price:update",
      url: "/api/wines/wine-a",
      method: "PATCH",
      json: { price: 20 },
    });

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    await expect(
      commands.json({
        slot: "price:update",
        url: "/api/wines/wine-a",
        method: "PATCH",
        json: { price: 21 },
      }),
    ).rejects.toBeInstanceOf(IdempotentCommandBusyError);
    resolveFetch?.(jsonResponse(200, { ok: true }));
    await first;
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("mints a new key for changed input after a retained failure", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { error: "wait" }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const commands = createIdempotentCommandStore({ fetchImpl });

    await commands.json({
      slot: "price:update",
      url: "/api/wines/wine-a",
      method: "PATCH",
      json: { price: 20 },
    });
    await commands.json({
      slot: "price:update",
      url: "/api/wines/wine-a",
      method: "PATCH",
      json: { price: 21 },
    });

    expect(keyAt(fetchImpl, 0)).not.toBe(keyAt(fetchImpl, 1));
  });

  it("treats reordered JSON object keys as the same command", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { error: "wait" }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const commands = createIdempotentCommandStore({ fetchImpl });

    await commands.json({
      slot: "wine:update",
      url: "/api/wines/wine-a",
      method: "PATCH",
      json: { producer: "Alpha", vintage: 2020 },
    });
    await commands.json({
      slot: "wine:update",
      url: "/api/wines/wine-a",
      method: "PATCH",
      json: { vintage: 2020, producer: "Alpha" },
    });

    expect(keyAt(fetchImpl, 0)).toBe(keyAt(fetchImpl, 1));
    expect((fetchImpl.mock.calls[0][1] as RequestInit).body).toBe(
      (fetchImpl.mock.calls[1][1] as RequestInit).body,
    );
  });

  it("rebuilds binary bodies without setting multipart content type", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { error: "wait" }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const makeBody = vi.fn(() => {
      const body = new FormData();
      body.append("file", new Blob(["wine"]));
      return body;
    });
    const commands = createIdempotentCommandStore({ fetchImpl });
    const command = {
      slot: "scan:invoice",
      url: "/api/scan",
      method: "POST" as const,
      fingerprint: "sha256:invoice-a",
      makeBody,
    };

    await commands.binary(command);
    await commands.binary(command);

    expect(makeBody).toHaveBeenCalledTimes(2);
    expect(keyAt(fetchImpl, 0)).toBe(keyAt(fetchImpl, 1));
    expect(
      new Headers(
        (fetchImpl.mock.calls[0][1] as RequestInit).headers,
      ).has("Content-Type"),
    ).toBe(false);
  });

  it("rejects caller-owned idempotency headers", () => {
    const commands = createIdempotentCommandStore({
      fetchImpl: vi.fn(),
    });

    expect(() =>
      commands.json({
        slot: "bad",
        url: "/api/cellar",
        method: "POST",
        headers: { "Idempotency-Key": "caller-key" },
        json: {},
      }),
    ).toThrow("owns Idempotency-Key");
  });

  it("loads only a matching persisted signature across stores", async () => {
    const persistence = memoryPersistence();
    const firstFetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(503, { error: "wait" }));
    const command = {
      slot: "open:wine-a",
      url: "/api/open-bottles",
      method: "POST" as const,
      json: { wine_id: "wine-a" },
    };
    await createIdempotentCommandStore({
      fetchImpl: firstFetch,
      persistence,
    }).json(command);

    const secondFetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { ok: true }));
    await createIdempotentCommandStore({
      fetchImpl: secondFetch,
      persistence,
    }).json(command);

    expect(keyAt(firstFetch, 0)).toBe(keyAt(secondFetch, 0));
    expect(
      JSON.stringify([...persistence.values.values()]),
    ).not.toContain("wine_id");
  });

  it("abandon clears a retained command and its persistence", async () => {
    const persistence = memoryPersistence();
    const fetchImpl = vi.fn(async () =>
      jsonResponse(503, { error: "wait" }),
    );
    const commands = createIdempotentCommandStore({
      fetchImpl,
      persistence,
    });
    const command = {
      slot: "open:wine-a",
      url: "/api/open-bottles",
      method: "POST" as const,
      json: { wine_id: "wine-a" },
    };

    await commands.json(command);
    commands.abandon(command.slot);
    await commands.json(command);

    expect(keyAt(fetchImpl, 0)).not.toBe(keyAt(fetchImpl, 1));
  });
});
