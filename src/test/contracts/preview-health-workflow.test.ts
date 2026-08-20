import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];
const headSha = "a".repeat(40);
const railwayEnvironmentId = "11111111-1111-4111-8111-111111111111";

const railwayComment = {
  user: { login: "railway-app[bot]", type: "Bot" },
  body: [
    "<!-- railway-bot-comment-version=2 -->",
    '<!-- railway-project-id="project-id" railway-project-name="PR Environments" -->',
    `[terroir-pr-123](https://railway.com/project/project-id?environmentId=${railwayEnvironmentId})`,
    "| Service | Status | Web | Updated (UTC) |",
    "| terroir | ✅ Success | [Web](https://terroir-pr-123.up.railway.app) | now |",
  ].join("\n"),
};

const railwayDeployment = {
  id: 42,
  sha: headSha,
  created_at: "2026-05-15T21:17:02Z",
  environment: "PR Environments / terroir-pr-123",
  creator: { login: "railway-app[bot]", type: "Bot" },
  payload: { environmentId: railwayEnvironmentId },
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function extractRunScript() {
  const workflow = readFileSync(
    resolve(process.cwd(), ".github/workflows/preview-health.yml"),
    "utf8",
  );
  const marker = "        run: |\n";
  const start = workflow.indexOf(marker);

  if (start === -1) {
    throw new Error("Preview health workflow has no run script");
  }

  const lines = workflow.slice(start + marker.length).split("\n");
  const scriptLines: string[] = [];
  for (const line of lines) {
    if (line.length > 0 && !line.startsWith("          ")) {
      break;
    }
    scriptLines.push(line.slice(10));
  }

  return `${scriptLines.join("\n")}\n`;
}

function installExecutable(directory: string, name: string, body: string) {
  const path = join(directory, name);
  writeFileSync(path, `#!/usr/bin/env bash\nset -eu\n${body}\n`);
  chmodSync(path, 0o755);
}

function runPreviewHealth(
  overrides: Record<string, string | undefined> = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "preview-health-test-"));
  temporaryDirectories.push(directory);
  const binDirectory = join(directory, "bin");
  mkdirSync(binDirectory);
  const curlLog = join(directory, "curl.log");
  const ghLog = join(directory, "gh.log");
  const scriptPath = join(directory, "preview-health.sh");

  installExecutable(
    binDirectory,
    "gh",
    [
      'endpoint="$2"',
      `printf '%s\\n' "$endpoint" >> "$GH_LOG"`,
      'case "$endpoint" in',
      '  *"/issues/"*"/comments"*)',
      `    printf '%s\\n' "$FAKE_COMMENTS_JSON"`,
      "    ;;",
      '  *"/deployments?"*)',
      '    if [[ " $* " == *" --jq "* ]]; then',
      `      printf '%s\\n' "$FAKE_DEPLOYMENTS_JSON" | jq -r 'map(select(.environment != "production")) | .[0].id'`,
      "    else",
      `      printf '%s\\n' "$FAKE_DEPLOYMENTS_JSON"`,
      "    fi",
      "    ;;",
      '  *"/deployments/"*"/statuses")',
      '    deployment_id="${endpoint#*/deployments/}"',
      '    deployment_id="${deployment_id%%/*}"',
      `    statuses=$(printf '%s\\n' "$FAKE_STATUSES_BY_ID" | jq -c --arg id "$deployment_id" '.[$id] // []')`,
      '    if [[ " $* " == *" --jq "* ]]; then',
      `      printf '%s\\n' "$statuses" | jq -c '.[0] | {state: .state, target: .target_url, env: .environment_url}'`,
      "    else",
      `      printf '%s\\n' "$statuses"`,
      "    fi",
      "    ;;",
      "esac",
    ].join("\n"),
  );
  installExecutable(
    binDirectory,
    "curl",
    [
      'requested_url=""',
      'for argument in "$@"; do',
      '  case "$argument" in',
      '    http*) requested_url="$argument" ;;',
      "  esac",
      "done",
      `printf '%s\\n' "$requested_url" >> "$CURL_LOG"`,
      'case "$requested_url" in',
      `  https://railway.com/*) http_code="$FAKE_DASHBOARD_HTTP_CODE" ;;`,
      `  *) http_code="$FAKE_APP_HTTP_CODE" ;;`,
      "esac",
      `printf '%s' "$http_code"`,
    ].join("\n"),
  );
  installExecutable(binDirectory, "sleep", "exit 0");
  writeFileSync(scriptPath, extractRunScript());

  const dashboardUrl =
    `https://railway.com/project/project-id?environmentId=${railwayEnvironmentId}`;
  const result = spawnSync("bash", [scriptPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
      CURL_LOG: curlLog,
      GH_LOG: ghLog,
      GITHUB_REPOSITORY: "example/terroir",
      PR_NUMBER: "123",
      HEAD_SHA: headSha,
      FAKE_COMMENTS_JSON: JSON.stringify([
        {
          user: { login: "contributor", type: "User" },
          body: "<!-- railway-bot-comment-version=2 -->\n[Web](https://attacker.up.railway.app)",
        },
        railwayComment,
      ]),
      FAKE_DEPLOYMENTS_JSON: JSON.stringify([railwayDeployment]),
      FAKE_STATUSES_BY_ID: JSON.stringify({
        "42": [
          {
            state: "success",
            environment_url: dashboardUrl,
            target_url: dashboardUrl,
          },
        ],
      }),
      FAKE_APP_HTTP_CODE: "200",
      FAKE_DASHBOARD_HTTP_CODE: "200",
      ...overrides,
    },
  });

  return {
    ...result,
    curlLog: readFileSync(curlLog, { encoding: "utf8", flag: "a+" }),
    ghLog: readFileSync(ghLog, { encoding: "utf8", flag: "a+" }),
  };
}

describe("preview health workflow", () => {
  it.each(["PR_NUMBER", "HEAD_SHA"])(
    "fails when GitHub omits %s from the PR metadata",
    (field) => {
      const result = runPreviewHealth({ [field]: "" });

      expect(result.status, result.stderr).toBe(1);
    },
  );

  it("fails after exhausting attempts without a Railway preview", () => {
    const result = runPreviewHealth({ FAKE_DEPLOYMENTS_JSON: "[]" });

    expect(result.status, result.stderr).toBe(1);
  });

  it.each(["failure", "error"])(
    "fails when Railway reports deployment state=%s",
    (state) => {
      const result = runPreviewHealth({
        FAKE_STATUSES_BY_ID: JSON.stringify({ "42": [{ state }] }),
      });

      expect(result.status, result.stderr).toBe(1);
    },
  );

  it.each([
    { httpCode: "200", expectedStatus: 0 },
    { httpCode: "503", expectedStatus: 1 },
  ])(
    "requires /api/health HTTP $httpCode after a ready preview",
    ({ httpCode, expectedStatus }) => {
      const result = runPreviewHealth({
        FAKE_APP_HTTP_CODE: httpCode,
        FAKE_DASHBOARD_HTTP_CODE: httpCode,
      });

      expect(result.status, result.stderr).toBe(expectedStatus);
      expect(result.curlLog).toBe(
        "https://terroir-pr-123.up.railway.app/api/health\n",
      );
    },
  );

  it("ignores an unrelated deployment for the same commit", () => {
    const unrelatedDeployment = {
      id: 99,
      sha: headSha,
      created_at: "2026-05-15T21:18:02Z",
      environment: "Terroir / staging",
      creator: { login: "railway-app[bot]", type: "Bot" },
      payload: {
        environmentId: "22222222-2222-4222-8222-222222222222",
      },
    };
    const result = runPreviewHealth({
      FAKE_DEPLOYMENTS_JSON: JSON.stringify([
        unrelatedDeployment,
        railwayDeployment,
      ]),
      FAKE_STATUSES_BY_ID: JSON.stringify({
        "42": [{ state: "failure" }],
        "99": [
          {
            state: "success",
            environment_url: "https://staging.example.test",
          },
        ],
      }),
    });

    expect(result.status, result.stderr).toBe(1);
    expect(result.ghLog).toContain("/deployments/42/statuses");
    expect(result.ghLog).not.toContain("/deployments/99/statuses");
    expect(result.curlLog).toBe("");
  });

  it("never health-checks a Railway dashboard URL", () => {
    const result = runPreviewHealth({
      FAKE_APP_HTTP_CODE: "503",
      FAKE_DASHBOARD_HTTP_CODE: "200",
    });

    expect(result.status, result.stderr).toBe(1);
    expect(result.curlLog).toBe(
      "https://terroir-pr-123.up.railway.app/api/health\n",
    );
  });
});
