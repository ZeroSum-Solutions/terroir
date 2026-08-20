import type { NextRequest } from "next/server";
import { vi } from "vitest";

type Result = { data: unknown; error: unknown };
type Operation = [string, ...unknown[]];

export function makeSupabase(results: Record<string, Result[]>) {
  const operations: Record<string, Operation[][]> = {};
  const from = vi.fn((table: string) => {
    const invocation = operations[table]?.length ?? 0;
    const ops: Operation[] = [];
    (operations[table] ??= []).push(ops);
    const result = results[table]?.[invocation] ?? {
      data: null,
      error: null,
    };
    const chain = {
      update: (...args: unknown[]) => (ops.push(["update", ...args]), chain),
      eq: (...args: unknown[]) => (ops.push(["eq", ...args]), chain),
      is: (...args: unknown[]) => (ops.push(["is", ...args]), chain),
      select: (...args: unknown[]) => (ops.push(["select", ...args]), chain),
      maybeSingle: async () => result,
      then: (resolve: (value: Result) => unknown) =>
        Promise.resolve(result).then(resolve),
    };
    return chain;
  });
  return { from, operations };
}

export function patchRequest(body: unknown): NextRequest {
  return new Request("http://localhost/api/bins/bin-a", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }) as unknown as NextRequest;
}

export const BIN_ID = "11111111-1111-4111-8111-111111111111";
export const PARAMS = () => ({ params: Promise.resolve({ id: BIN_ID }) });
