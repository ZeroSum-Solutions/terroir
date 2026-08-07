type Environment = Record<string, string | undefined>;

export type RealAuthE2eConfig = {
  baseUrl: string;
  emailDomain: string;
  mailboxUrl: string;
  mailboxAuthorization?: string;
  runId: string;
  supabaseUrl: string;
  serviceRoleKey: string;
};

function required(env: Environment, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} must be set when AUTH_E2E_ENABLED=1.`);
  return value;
}

function parseHttpsUrl(value: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL.`);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`${name} must be an HTTPS URL without embedded credentials.`);
  }
  return url;
}

/**
 * Reads the only opt-in configuration that may run the real-provider browser
 * suite. The test rejects a production-like target by construction and never
 * accepts a user email/password from the environment.
 */
export function getRealAuthE2eConfig(
  env: Environment = process.env,
): RealAuthE2eConfig | null {
  if (env.AUTH_E2E_ENABLED !== "1") return null;

  const base = parseHttpsUrl(required(env, "AUTH_E2E_BASE_URL"), "AUTH_E2E_BASE_URL");
  if (!base.hostname.includes("staging")) {
    throw new Error("AUTH_E2E_BASE_URL must target the named staging host.");
  }

  const mailbox = parseHttpsUrl(
    required(env, "AUTH_E2E_MAILBOX_URL"),
    "AUTH_E2E_MAILBOX_URL",
  );
  const supabase = parseHttpsUrl(
    required(env, "AUTH_E2E_SUPABASE_URL"),
    "AUTH_E2E_SUPABASE_URL",
  );
  const productionPattern = required(
    env,
    "AUTH_E2E_PRODUCTION_SUPABASE_URL_PATTERN",
  );
  if (supabase.href.includes(productionPattern)) {
    throw new Error("AUTH_E2E_SUPABASE_URL matches the production safety pattern.");
  }
  const emailDomain = required(env, "AUTH_E2E_EMAIL_DOMAIN").toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9-]+)+$/.test(emailDomain)) {
    throw new Error("AUTH_E2E_EMAIL_DOMAIN must be a domain used only by the test inbox.");
  }
  const runId = required(env, "AUTH_E2E_RUN_ID");
  if (!/^[a-z0-9-]{8,80}$/i.test(runId)) {
    throw new Error("AUTH_E2E_RUN_ID must be an opaque 8-80 character run identifier.");
  }

  const username = env.AUTH_E2E_MAILBOX_USERNAME?.trim();
  const password = env.AUTH_E2E_MAILBOX_PASSWORD;
  if (Boolean(username) !== Boolean(password)) {
    throw new Error(
      "AUTH_E2E_MAILBOX_USERNAME and AUTH_E2E_MAILBOX_PASSWORD must be set together.",
    );
  }

  return {
    baseUrl: base.origin,
    emailDomain,
    mailboxUrl: mailbox.origin,
    mailboxAuthorization: username && password
      ? `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
      : undefined,
    runId,
    supabaseUrl: supabase.origin,
    serviceRoleKey: required(env, "AUTH_E2E_SERVICE_ROLE_KEY"),
  };
}

export function isolatedAuthE2eEmail(
  config: RealAuthE2eConfig,
  purpose: string,
): string {
  if (!/^[a-z0-9-]+$/i.test(purpose)) {
    throw new Error("Auth E2E purposes must be simple opaque labels.");
  }
  return `terroir-${purpose}-${config.runId}@${config.emailDomain}`.toLowerCase();
}

export async function waitForMailpitEmail(
  config: RealAuthE2eConfig,
  recipient: string,
): Promise<string> {
  const endpoint = new URL("/view/latest.html", config.mailboxUrl);
  endpoint.searchParams.set("query", `to:\"${recipient}\"`);

  for (let attempt = 0; attempt < 45; attempt += 1) {
    const response = await fetch(endpoint, {
      headers: config.mailboxAuthorization
        ? { Authorization: config.mailboxAuthorization }
        : undefined,
    });
    if (response.ok) return response.text();
    if (response.status !== 404) {
      throw new Error(`Mailpit returned ${response.status} while waiting for ${recipient}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`Timed out waiting for test email to ${recipient}.`);
}

export function extractAuthEmailLink(html: string): string {
  const hrefs = Array.from(html.matchAll(/href=["']([^"']+)["']/gi), (match) =>
    match[1].replaceAll("&amp;", "&"),
  );
  const link = hrefs.find((href) => {
    try {
      const url = new URL(href);
      return url.searchParams.has("token") || url.searchParams.has("token_hash");
    } catch {
      return false;
    }
  });
  if (!link) throw new Error("Test mailbox email did not contain an auth token link.");
  return link;
}
