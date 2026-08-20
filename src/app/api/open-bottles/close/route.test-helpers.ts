import { type NextRequest } from "next/server";
import { vi } from "vitest";

export const WINE_ID = "a1b2c3d4-e5f6-4789-8abc-def012345678";
export const BOTTLE_ID = "b1b2c3d4-e5f6-4789-8abc-def012345678";
export const REASON_ID = "d1b2c3d4-e5f6-4789-8abc-def012345678";

type RpcError = { code?: string; message?: string };

export function makeAuthenticatedClient(
  options: { rpcError?: RpcError | null; bottleWineId?: string | null } = {},
) {
  const closeout = {
    id: "closeout-1",
    open_bottle_id: BOTTLE_ID,
    wine_id: WINE_ID,
    theoretical_remaining_ml: 600,
    actual_remaining_ml: 570,
    variance_ml: -30,
    written_off_ml: 30,
    reason_code_id: REASON_ID,
    preservation_method: "coravin",
  };
  const rpc = vi.fn().mockResolvedValue({
    data: options.rpcError ? null : closeout,
    error: options.rpcError ?? null,
  });

  const maybeSingle = vi.fn().mockResolvedValue({
    data: options.bottleWineId === null
      ? null
      : { wine_id: options.bottleWineId ?? WINE_ID },
    error: null,
  });
  const chain = {
    select: () => chain,
    eq: () => chain,
    is: () => chain,
    maybeSingle,
  };
  const from = vi.fn().mockReturnValue(chain);

  return { client: { from, rpc }, from, rpc, closeout };
}

export function request(body: unknown): NextRequest {
  return new Request("http://localhost/api/open-bottles/close", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}
