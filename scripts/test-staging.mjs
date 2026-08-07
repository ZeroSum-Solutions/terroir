#!/usr/bin/env node

const STAGING_ORIGIN = "https://terroir-web-staging.up.railway.app";
const MAX_ATTEMPTS = 20;

function fail(message) {
  throw new Error(`[staging smoke] ${message}`);
}

function stagingUrl() {
  const value = process.env.STAGING_URL ?? STAGING_ORIGIN;
  let url;

  try {
    url = new URL(value);
  } catch {
    fail("STAGING_URL must be a valid URL.");
  }

  if (
    url.protocol !== "https:" ||
    url.hostname !== "terroir-web-staging.up.railway.app" ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    fail(`refusing to target anything except ${STAGING_ORIGIN}`);
  }

  return url;
}

function expectedSha() {
  const sha = process.env.STAGING_EXPECTED_SHA;
  if (sha === undefined || sha === "") return undefined;
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) {
    fail("STAGING_EXPECTED_SHA must be a Git SHA.");
  }
  return sha.toLowerCase();
}

function attemptCount() {
  const value = process.env.STAGING_SMOKE_ATTEMPTS ?? "1";
  if (!/^[1-9][0-9]*$/.test(value)) {
    fail("STAGING_SMOKE_ATTEMPTS must be a positive integer.");
  }
  const attempts = Number(value);
  if (attempts > MAX_ATTEMPTS) {
    fail(`STAGING_SMOKE_ATTEMPTS must not exceed ${MAX_ATTEMPTS}.`);
  }
  return attempts;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function get(url, path) {
  const response = await fetch(new URL(path, url), {
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
    headers: { Accept: "application/json, text/html;q=0.9" },
  });
  return response;
}

async function smokeOnce(url, sha) {
  const root = await get(url, "/");
  if (![307, 308].includes(root.status)) {
    fail(`GET / returned ${root.status}; expected an unauthenticated redirect.`);
  }
  const rootLocation = root.headers.get("location") ?? "";
  if (!rootLocation.startsWith("/login")) {
    fail("GET / did not redirect to the local login route.");
  }

  const login = await get(url, "/login");
  if (login.status !== 200 || !login.headers.get("content-type")?.includes("text/html")) {
    fail(`GET /login returned ${login.status}; expected HTML 200.`);
  }

  const health = await get(url, "/api/health");
  if (health.status !== 200) {
    fail(`GET /api/health returned ${health.status}; expected 200.`);
  }
  if (health.headers.get("cache-control") !== "no-store") {
    fail("GET /api/health must return Cache-Control: no-store.");
  }

  const body = await health.json();
  if (body.status !== "ok" || body.db !== "connected") {
    fail("GET /api/health did not confirm a connected database.");
  }
  if (body.environment !== "staging") {
    fail("GET /api/health did not confirm the Railway staging environment.");
  }
  if (sha && body.release !== sha) {
    fail(`staging reports release ${body.release ?? "missing"}, expected ${sha}.`);
  }

  console.log(
    JSON.stringify({
      target: url.origin,
      checks: ["unauthenticated-route", "login", "health", "database", "environment"],
      release: body.release ?? null,
      expectedRelease: sha ?? null,
      result: "passed",
    }),
  );
}

async function main() {
  const url = stagingUrl();
  const sha = expectedSha();
  const attempts = attemptCount();
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await smokeOnce(url, sha);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        console.error(`[staging smoke] attempt ${attempt}/${attempts} failed; retrying in 15 seconds.`);
        await delay(15_000);
      }
    }
  }

  throw lastError;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
