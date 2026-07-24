import { AsyncLocalStorage } from "node:async_hooks";

type ApiRequestContext = {
  rateLimitHeaders?: Record<string, string>;
};

const storage = new AsyncLocalStorage<ApiRequestContext>();

export function runWithApiRequestContext<T>(
  operation: () => T | Promise<T>,
): Promise<T> {
  return Promise.resolve(storage.run({}, operation));
}

export function setRateLimitHeaders(headers: Record<string, string>): void {
  const context = storage.getStore();
  if (context) context.rateLimitHeaders = headers;
}

export function applyApiRequestHeaders(response: Response): Response {
  const rateLimitHeaders = storage.getStore()?.rateLimitHeaders;
  if (!rateLimitHeaders) return response;
  for (const [name, value] of Object.entries(rateLimitHeaders)) {
    response.headers.set(name, value);
  }
  return response;
}
