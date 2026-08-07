const baseUrl = process.env.ALERT_DRILL_BASE_URL?.trim();
const token = process.env.ALERT_DRILL_TOKEN?.trim();
const STAGING_ORIGIN = "https://terroir-web-staging.up.railway.app";

if (!baseUrl || !token) {
  throw new Error(
    "ALERT_DRILL_BASE_URL and ALERT_DRILL_TOKEN are required in the process environment.",
  );
}
if (token.length < 32 || token.length > 256) {
  throw new Error("ALERT_DRILL_TOKEN must contain 32 to 256 characters.");
}

const target = new URL("/api/health", baseUrl);
const isLocal = ["localhost", "127.0.0.1", "::1"].includes(target.hostname);
if (target.username || target.password) {
  throw new Error("Alert drill URLs must not contain credentials.");
}
if (!isLocal && target.origin !== STAGING_ORIGIN) {
  throw new Error(
    `Remote alert drills are restricted to ${STAGING_ORIGIN}.`,
  );
}
if (!isLocal && target.protocol !== "https:") {
  throw new Error("Remote alert drills require HTTPS.");
}

target.searchParams.set("drill", "readiness");
const response = await fetch(target, {
  headers: { "x-terroir-observability-drill": token },
  redirect: "error",
  signal: AbortSignal.timeout(10_000),
});
const text = await response.text();
if (!response.ok) {
  throw new Error(`Alert drill request failed with HTTP ${response.status}.`);
}

let body;
try {
  body = JSON.parse(text);
} catch {
  throw new Error("Alert drill response was not JSON.");
}

const alert = body?.alertDrill;
const required = [
  "environment",
  "severity",
  "service",
  "eventName",
  "firstOccurrence",
  "lastOccurrence",
  "count",
  "requestId",
  "runbook",
];
if (
  body?.readiness !== "degraded" ||
  body?.dbReason !== "forced_failure" ||
  !alert ||
  required.some((name) => alert[name] === undefined)
) {
  throw new Error("Alert drill response did not contain the required safe envelope.");
}
if (text.includes(token)) {
  throw new Error("Alert drill response reflected the raw drill token.");
}

console.log(
  JSON.stringify({
    event: "alert_drill_verified",
    target: target.origin,
    alert,
  }),
);
