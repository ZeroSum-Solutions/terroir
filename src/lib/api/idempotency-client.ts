const RETAIN_KEY_CODES = new Set([
  "idempotency_in_progress",
  "idempotency_outcome_unknown",
  "idempotency_unavailable",
]);

const RETAIN_STATUSES = new Set([408, 425, 429]);

type MutationMethod = "POST" | "PUT" | "PATCH" | "DELETE";

type CommandBase = {
  slot: string;
  url: string;
  method: MutationMethod;
  headers?: HeadersInit;
  signal?: AbortSignal;
  parse?: "json" | "none";
};

export type JsonIdempotentCommand = CommandBase & {
  json?: unknown;
};

export type BinaryIdempotentCommand = CommandBase & {
  fingerprint: string;
  makeBody: () => BodyInit;
};

export type IdempotentCommandResult<T> = {
  response: Response;
  data: T;
};

export type IdempotentCommandPersistence = {
  load(slot: string, signatureHash: string): string | null;
  save(
    slot: string,
    signatureHash: string,
    key: string,
  ): void;
  clear(slot: string): void;
};

type ActiveCommand = {
  signature: string;
  signatureHash: string | null;
  key: string;
  inFlight: Promise<IdempotentCommandResult<unknown>> | null;
};

export class IdempotentCommandBusyError extends Error {
  constructor(slot: string) {
    super(`A different idempotent command is already running in slot ${slot}`);
    this.name = "IdempotentCommandBusyError";
  }
}

export class IdempotentResponseParseError extends Error {
  readonly response: Response;

  constructor(response: Response) {
    super("The idempotent command response could not be read.");
    this.name = "IdempotentResponseParseError";
    this.response = response;
  }
}

export function createIdempotencyKey(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  if (typeof cryptoApi?.getRandomValues === "function") {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  }
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

export async function createBinaryCommandFingerprint(
  identity: unknown,
  ...parts: readonly (Blob | Uint8Array)[]
): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error(
      "Web Crypto is required for binary command fingerprinting.",
    );
  }
  const chunks: Uint8Array[] = [
    new TextEncoder().encode(canonicalClientJson(identity)),
  ];
  for (const part of parts) {
    chunks.push(
      part instanceof Uint8Array
        ? part
        : new Uint8Array(await part.arrayBuffer()),
    );
  }
  const framed = frameBinaryParts(chunks);
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    framed.buffer as ArrayBuffer,
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function readApiErrorCode(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/**
 * Keep one logical action's key across transient or outcome-ambiguous errors.
 * Deterministic client errors release it so corrected input starts a new
 * logical request instead of conflicting with the old request hash.
 */
export function shouldRetainIdempotencyKey(
  status: number,
  errorCode: string | null,
): boolean {
  return (
    RETAIN_STATUSES.has(status) ||
    status >= 500 ||
    (errorCode !== null && RETAIN_KEY_CODES.has(errorCode))
  );
}

/**
 * Owns one idempotency key per logical action slot.
 *
 * The store freezes JSON before sending, binds keys to the exact request
 * signature, coalesces duplicate in-flight submissions, and retains a key
 * only when the outcome is transient or ambiguous. It never retries on its
 * own. Binary callers supply a semantic fingerprint and a fresh body factory.
 */
export function createIdempotentCommandStore(options?: {
  fetchImpl?: typeof fetch;
  persistence?: IdempotentCommandPersistence;
}) {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const persistence = options?.persistence;
  const active = new Map<string, ActiveCommand>();

  async function run<T>(input: {
    base: CommandBase;
    kind: "json" | "binary";
    identity: unknown;
    makeBody: () => BodyInit | null;
    headers: Headers;
  }): Promise<IdempotentCommandResult<T>> {
    const { base, kind, identity, makeBody, headers } = input;
    const signature = canonicalClientJson({
      method: base.method,
      url: base.url,
      headers: [...headers.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      ),
      kind,
      identity,
    });
    const current = active.get(base.slot);
    if (current?.inFlight) {
      if (current.signature !== signature) {
        throw new IdempotentCommandBusyError(base.slot);
      }
      return current.inFlight as Promise<IdempotentCommandResult<T>>;
    }
    if (current && current.signature !== signature) {
      clearPersisted(persistence, base.slot);
      active.delete(base.slot);
    }

    const command =
      active.get(base.slot) ??
      ({
        signature,
        signatureHash: null,
        key: createIdempotencyKey(),
        inFlight: null,
      } satisfies ActiveCommand);
    active.set(base.slot, command);

    const execution = executeCommand<T>({
      base,
      signature,
      command,
      makeBody,
      headers,
      fetchImpl,
      persistence,
      active,
    });
    command.inFlight =
      execution as Promise<IdempotentCommandResult<unknown>>;
    try {
      return await execution;
    } finally {
      const latest = active.get(base.slot);
      if (latest === command) latest.inFlight = null;
    }
  }

  return {
    json<T>(command: JsonIdempotentCommand) {
      const headers = commandHeaders(command.headers, true);
      const serialized = canonicalClientJson(command.json ?? null);
      return run<T>({
        base: command,
        kind: "json",
        identity: serialized,
        makeBody: () => serialized,
        headers,
      });
    },

    binary<T>(command: BinaryIdempotentCommand) {
      if (
        typeof command.fingerprint !== "string" ||
        command.fingerprint.length === 0
      ) {
        throw new TypeError(
          "Binary idempotent commands require a fingerprint.",
        );
      }
      const headers = commandHeaders(command.headers, false);
      return run<T>({
        base: command,
        kind: "binary",
        identity: command.fingerprint,
        makeBody: command.makeBody,
        headers,
      });
    },

    abandon(slot: string) {
      const command = active.get(slot);
      if (command?.inFlight) {
        throw new IdempotentCommandBusyError(slot);
      }
      active.delete(slot);
      clearPersisted(persistence, slot);
    },
  };
}

export function createSessionCommandPersistence(
  namespace: string,
): IdempotentCommandPersistence {
  const storageKey = (slot: string) =>
    `${namespace}:${encodeURIComponent(slot)}`;

  return {
    load(slot, signatureHash) {
      try {
        const raw = sessionStorage.getItem(storageKey(slot));
        if (!raw) return null;
        const parsed = JSON.parse(raw) as {
          signatureHash?: unknown;
          key?: unknown;
        };
        if (
          parsed.signatureHash !== signatureHash ||
          typeof parsed.key !== "string" ||
          !isClientIdempotencyKey(parsed.key)
        ) {
          sessionStorage.removeItem(storageKey(slot));
          return null;
        }
        return parsed.key;
      } catch {
        return null;
      }
    },
    save(slot, signatureHash, key) {
      try {
        sessionStorage.setItem(
          storageKey(slot),
          JSON.stringify({ signatureHash, key }),
        );
      } catch {
        // Memory ownership still protects retries in this mount.
      }
    },
    clear(slot) {
      try {
        sessionStorage.removeItem(storageKey(slot));
      } catch {
        // Storage availability cannot change the server-side result.
      }
    },
  };
}

async function executeCommand<T>(options: {
  base: CommandBase;
  signature: string;
  command: ActiveCommand;
  makeBody: () => BodyInit | null;
  headers: Headers;
  fetchImpl: typeof fetch;
  persistence?: IdempotentCommandPersistence;
  active: Map<string, ActiveCommand>;
}): Promise<IdempotentCommandResult<T>> {
  const {
    base,
    signature,
    command,
    makeBody,
    headers,
    fetchImpl,
    persistence,
    active,
  } = options;

  if (command.signatureHash === null) {
    command.signatureHash = await digestCommandSignature(signature);
    if (command.signatureHash && persistence) {
      try {
        const persisted = persistence.load(
          base.slot,
          command.signatureHash,
        );
        if (persisted && isClientIdempotencyKey(persisted)) {
          command.key = persisted;
        }
        persistence.save(
          base.slot,
          command.signatureHash,
          command.key,
        );
      } catch {
        // Persistence cannot prevent the in-memory command from running.
      }
    }
  }

  let body: BodyInit | null;
  try {
    body = makeBody();
  } catch (error) {
    active.delete(base.slot);
    clearPersisted(persistence, base.slot);
    throw error;
  }

  headers.set("Idempotency-Key", command.key);
  let response: Response;
  try {
    response = await fetchImpl(base.url, {
      method: base.method,
      headers,
      body,
      signal: base.signal,
    });
  } catch (error) {
    // A transport exception cannot prove whether the server committed.
    throw error;
  }

  let data: unknown = undefined;
  if ((base.parse ?? "json") === "json") {
    try {
      data = await response.json();
    } catch {
      // Even a 2xx is ambiguous until its promised response is consumed.
      throw new IdempotentResponseParseError(response);
    }
  }

  const retain =
    !response.ok &&
    shouldRetainIdempotencyKey(
      response.status,
      readApiErrorCode(data),
    );
  if (response.ok || !retain) {
    active.delete(base.slot);
    clearPersisted(persistence, base.slot);
  }

  return {
    response,
    data: data as T,
  };
}

function commandHeaders(
  input: HeadersInit | undefined,
  json: boolean,
): Headers {
  const headers = new Headers(input);
  if (headers.has("Idempotency-Key")) {
    throw new TypeError(
      "The idempotent command store owns Idempotency-Key.",
    );
  }
  if (json && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return headers;
}

function isClientIdempotencyKey(value: string): boolean {
  return (
    value.length >= 8 &&
    value.length <= 128 &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function clearPersisted(
  persistence: IdempotentCommandPersistence | undefined,
  slot: string,
): void {
  try {
    persistence?.clear(slot);
  } catch {
    // Persistence is an extra remount safeguard, not the command authority.
  }
}

async function digestCommandSignature(
  signature: string,
): Promise<string | null> {
  try {
    if (!globalThis.crypto?.subtle) return null;
    const digest = await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(signature),
    );
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  } catch {
    return null;
  }
}

function canonicalClientJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Command identity contains a non-finite number.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalClientJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalClientJson(object[key])}`,
      )
      .join(",")}}`;
  }
  throw new TypeError(
    `Unsupported command identity value: ${typeof value}`,
  );
}

function frameBinaryParts(parts: readonly Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce(
    (total, part) => total + 8 + part.byteLength,
    0,
  );
  const framed = new Uint8Array(totalLength);
  const view = new DataView(framed.buffer);
  let offset = 0;
  for (const part of parts) {
    view.setBigUint64(offset, BigInt(part.byteLength));
    offset += 8;
    framed.set(part, offset);
    offset += part.byteLength;
  }
  return framed;
}
