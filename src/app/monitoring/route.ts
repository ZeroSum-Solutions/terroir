import { NextResponse } from "next/server";

const MAX_ENVELOPE_BYTES = 1_000_000;
const SENTRY_INGEST_HOST = /^o\d+\.ingest(?:\.[a-z0-9-]+)?\.sentry\.io$/i;

function ingestEndpoint(): URL | null {
  const rawDsn = process.env.NEXT_PUBLIC_SENTRY_DSN?.trim();
  if (!rawDsn) return null;

  try {
    const dsn = new URL(rawDsn);
    const projectId = dsn.pathname.split("/").filter(Boolean).at(-1);
    if (
      dsn.protocol !== "https:"
      || !SENTRY_INGEST_HOST.test(dsn.hostname)
      || !projectId
      || !/^\d+$/.test(projectId)
    ) {
      return null;
    }
    return new URL(`/api/${projectId}/envelope/`, dsn.origin);
  } catch {
    return null;
  }
}

/**
 * Same-origin Sentry envelope tunnel. The destination is derived only from
 * the deployment DSN and restricted to Sentry ingest hosts, so request data
 * can never turn this endpoint into an open proxy.
 */
export async function POST(request: Request): Promise<Response> {
  const endpoint = ingestEndpoint();
  if (!endpoint) {
    return NextResponse.json(
      { error: "Monitoring is not configured." },
      { status: 503 },
    );
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ENVELOPE_BYTES) {
    return NextResponse.json({ error: "Envelope is too large." }, { status: 413 });
  }

  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_ENVELOPE_BYTES) {
    return NextResponse.json({ error: "Envelope is too large." }, { status: 413 });
  }

  try {
    const upstream = await fetch(endpoint, {
      body,
      cache: "no-store",
      headers: { "Content-Type": "application/x-sentry-envelope" },
      method: "POST",
    });
    return new Response(upstream.body, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": upstream.headers.get("content-type") ?? "text/plain",
      },
      status: upstream.status,
    });
  } catch {
    return NextResponse.json(
      { error: "Monitoring delivery failed." },
      { status: 502 },
    );
  }
}
