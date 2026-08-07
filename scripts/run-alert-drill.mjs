const baseUrl = process.env.ALERT_DRILL_BASE_URL?.trim();
const token = process.env.ALERT_DRILL_TOKEN?.trim();

if (!baseUrl || !token) {
  throw new Error(
    "ALERT_DRILL_BASE_URL and ALERT_DRILL_TOKEN are required in the process environment.",
  );
}

const target = new URL("/api/health", baseUrl);
const isLocal = ["localhost", "127.0.0.1", "::1"].includes(target.hostname);
if (!isLocal && !target.hostname.toLowerCase().includes("staging")) {
  throw new Error("Alert drills are restricted to localhost or a staging hostname.");
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
