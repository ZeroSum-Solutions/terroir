// Makes a locally-green run tell the truth about what it did NOT run.
//
// Seven suites gate themselves on live-Postgres env vars and use
// `describe.skipIf`, so without a local Supabase stack they vanish from the
// run. `pnpm test` then prints "2470 passed" and exits 0 while 47 tests —
// including every cross-tenant containment suite and the import hardening
// suite — never executed. The suites' own headers call them MANDATORY, and in
// CI they throw rather than skip, so the gap is local-only and therefore
// exactly where nobody is watching: a fresh clone reports success for a suite
// it never ran.
//
// This does not change what runs. It prints, after the run, which suites were
// inert and the exact commands that would enable them. Silence here means
// every suite executed.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const LIVE_DB_MARKER = "const hasLiveDb";
const YELLOW = "\u001b[33m";
const RESET = "\u001b[0m";

function findLiveDbSuites(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      findLiveDbSuites(full, out);
    } else if (/\.test\.tsx?$/.test(entry)) {
      // Read-only scan: cheap enough at this repo's size, and it cannot drift
      // out of date the way a hard-coded list of suite paths would.
      if (readFileSync(full, "utf8").includes(LIVE_DB_MARKER)) {
        out.push(path.relative(process.cwd(), full));
      }
    }
  }
  return out;
}

export default function setup() {
  const hasLiveDb = Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.SUPABASE_SERVICE_ROLE_KEY,
  );

  return () => {
    // CI already fails loudly if the stack is missing — the suites throw there
    // rather than skipping. This banner is for local runs only.
    if (hasLiveDb || process.env.CI) return;

    const srcDir = path.resolve(process.cwd(), "src");
    if (!existsSync(srcDir)) return;

    const suites = findLiveDbSuites(srcDir).sort();
    if (suites.length === 0) return;

    const envExample = existsSync(
      path.resolve(process.cwd(), ".env.local.example"),
    )
      ? ".env.local.example"
      : ".env.example";

    process.stderr.write(
      [
        "",
        YELLOW + "-".repeat(74),
        "  THIS RUN WAS GREEN WITHOUT THE LIVE-DATABASE SUITES.",
        "-".repeat(74),
        `  ${suites.length} suite(s) skipped themselves because no local Supabase`,
        "  stack was configured. They are not optional coverage — they include",
        "  the cross-tenant containment tests:",
        "",
        ...suites.map((s) => `    - ${s}`),
        "",
        "  To run them:",
        "    supabase start",
        `    cp ${envExample} .env.local   # then fill in the printed keys`,
        "    pnpm run supabase:seed:local:apply",
        "",
        "  Use the keys `supabase start` just printed, and nothing else. These",
        "  suites hold a service-role key that bypasses RLS and they create and",
        "  delete tenant data on purpose; pointed at a hosted project they would",
        "  do that to real data. They refuse any non-loopback target outright.",
        "",
        "  CI runs them for real and FAILS if the stack is missing, so this is",
        "  a local-only blind spot. Silence here means everything ran.",
        "-".repeat(74) + RESET,
        "",
      ].join("\n"),
    );
  };
}
