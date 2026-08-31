/**
 * LIST-05 — derive a brand kit from a business website.
 *
 * The house scraping order is crawl4ai first, Firecrawl only on a bot wall —
 * with one documented exception, which is exactly this case: Firecrawl's
 * `branding` format is Firecrawl-only, and it is the correct first call for
 * "read a site's brand". crawl4ai returns page *text*; it cannot see a
 * computed palette, so it is not a substitute here.
 *
 * Server-side only. The key never reaches the browser.
 */

const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape";
const HEX = /^#[0-9a-f]{6}$/i;

/** Cap on a logo we are willing to persist as a data: URI or remote reference. */
const MAX_LOGO_URL_LENGTH = 2 * 1024 * 1024;

export type UrlValidation =
  | { ok: true; url: URL }
  | { ok: false; reason: string };

/**
 * Reject anything that is not a public http(s) site.
 *
 * The URL is handed to a third party rather than fetched here, but it is still
 * attacker-controlled input arriving on an authenticated endpoint: a
 * `file:`/`gopher:` scheme, a loopback address, or an RFC1918 / link-local host
 * has no legitimate use and is refused outright.
 */
export function validateBusinessUrl(raw: string): UrlValidation {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: "Enter a website address." };

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return { ok: false, reason: "That does not look like a website address." };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "Only http and https addresses are supported." };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "Remove the credentials from the address." };
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isPrivateHost(host)) {
    return { ok: false, reason: "That address is not a public website." };
  }
  if (!host.includes(".") && host !== "localhost") {
    return { ok: false, reason: "Enter a full domain, e.g. example.com." };
  }
  return { ok: true, url };
}

/** A bare 1-4 digit hex group, as found between colons in an IPv6 literal. */
function isHexGroup(value: string): boolean {
  return /^[0-9a-f]{1,4}$/i.test(value);
}

/**
 * Expand an IPv6 literal (no brackets, no zone id) to its 8 groups, each a
 * hex string — except the last one or two groups, which stay as decimal
 * octet strings when the literal ends in a dotted-quad (`...:a.b.c.d`).
 * Returns null when `host` is not a syntactically plausible IPv6 address.
 */
function expandIpv6Groups(host: string): string[] | null {
  let hex = host;
  let ipv4Tail: [string, string] | null = null;

  const lastColon = hex.lastIndexOf(":");
  const afterLastColon = lastColon >= 0 ? hex.slice(lastColon + 1) : hex;
  if (afterLastColon.includes(".")) {
    const octets = afterLastColon.split(".");
    if (
      octets.length !== 4 ||
      !octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255)
    ) {
      return null;
    }
    const [o0, o1, o2, o3] = octets.map(Number);
    ipv4Tail = [
      (((o0 << 8) | o1) >>> 0).toString(16),
      (((o2 << 8) | o3) >>> 0).toString(16),
    ];
    hex = hex.slice(0, lastColon);
  }

  const parts = hex.split("::");
  if (parts.length > 2) return null; // "::" can appear at most once

  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  if (!head.every(isHexGroup) || !tail.every(isHexGroup)) return null;

  const ipv4GroupCount = ipv4Tail ? 2 : 0;
  const known = head.length + tail.length + ipv4GroupCount;

  if (parts.length === 1) {
    // No "::" compression — the literal must spell out all 8 groups.
    return known === 8 ? [...head, ...tail, ...(ipv4Tail ?? [])] : null;
  }
  const fillCount = 8 - known;
  if (fillCount < 1) return null; // "::" must stand in for at least one group
  return [...head, ...Array(fillCount).fill("0"), ...tail, ...(ipv4Tail ?? [])];
}

/**
 * Decode an IPv6-mapped IPv4 address to its dotted-quad IPv4 string, or
 * null when `host` is not that shape. Covers `::ffff:a.b.c.d`, the
 * hex-compressed `::ffff:xxxx:xxxx` WHATWG normalises it to, and the
 * fully-expanded `0:0:0:0:0:ffff:…` form of either.
 */
function decodeIpv4MappedIpv6(host: string): string | null {
  if (!host.includes(":")) return null;
  const groups = expandIpv6Groups(host.toLowerCase());
  if (!groups || groups.length !== 8) return null;
  if (!groups.slice(0, 5).every((g) => /^0{1,4}$/.test(g))) return null;
  if (groups[5] !== "ffff") return null;
  const hi = Number.parseInt(groups[6], 16);
  const lo = Number.parseInt(groups[7], 16);
  if (Number.isNaN(hi) || Number.isNaN(lo)) return null;
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

/** Loopback, link-local, and the private IPv4/IPv6 ranges, plus bare hostnames. */
function isPrivateHost(host: string): boolean {
  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return true;
  }
  if (host === "::1" || host === "::") return true;
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) {
    return true;
  }
  // IPv6-mapped IPv4 (::ffff:a.b.c.d and friends) decodes to a plain IPv4
  // string and falls through to the same rules below — no separate range
  // table to keep in sync with the one just past this comment.
  const ipv4Host = decodeIpv4MappedIpv6(host) ?? host;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ipv4Host);
  if (!ipv4) return false;
  const [a, b] = ipv4.slice(1).map(Number);
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return a >= 224; // multicast / reserved
}

export type SiteBranding = {
  colors: string[];
  logoUrl: string | null;
};

type FirecrawlBranding = {
  colors?: Record<string, unknown>;
  images?: { logo?: unknown };
};

/**
 * The colour roles worth keeping, in the order they should appear as swatches.
 * `BrandKitPaletteSchema` allows at most six.
 */
const COLOUR_ROLES = [
  "primary",
  "secondary",
  "accent",
  "background",
  "textPrimary",
  "link",
] as const;

/** Map one Firecrawl `branding` payload onto the stored brand-kit shape. */
export function brandingToPalette(branding: unknown): SiteBranding {
  const value = (branding ?? {}) as FirecrawlBranding;
  const seen = new Set<string>();
  const colors: string[] = [];
  for (const role of COLOUR_ROLES) {
    const candidate = value.colors?.[role];
    if (typeof candidate !== "string" || !HEX.test(candidate.trim())) continue;
    const hex = candidate.trim().toUpperCase();
    if (seen.has(hex)) continue;
    seen.add(hex);
    colors.push(hex);
  }
  return { colors, logoUrl: safeLogoUrl(value.images?.logo) };
}

/**
 * Only an inline image or an https image on a public host is stored — the
 * panel renders it in an `<img>`, so a `javascript:`/`http:` value would be
 * either dangerous or a mixed-content blank, and an https value pointed at
 * loopback/RFC1918/link-local would let the panel's `<img>` probe a staff
 * browser's private network on Firecrawl's say-so. Same host policy as
 * `validateBusinessUrl`, applied here because this URL is untouched by that
 * check — it comes back FROM Firecrawl, not INTO it.
 *
 * `data:image/svg+xml` is refused even though other `data:image/` values are
 * allowed: SVG can carry `<script>`/event-handler content, unlike the raster
 * formats this prefix is meant for.
 */
export function safeLogoUrl(candidate: unknown): string | null {
  if (typeof candidate !== "string") return null;
  const value = candidate.trim();
  if (value.length === 0 || value.length > MAX_LOGO_URL_LENGTH) return null;
  if (value.startsWith("data:image/")) {
    const subtype = /^data:image\/([^;,]*)/i.exec(value)?.[1]?.toLowerCase();
    return subtype === "svg+xml" ? null : value;
  }
  if (!/^https:\/\//i.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return isPrivateHost(host) ? null : value;
}

export class SiteBrandingError extends Error {
  constructor(
    message: string,
    readonly code:
      | "brand_kit_url_unavailable"
      | "brand_kit_url_unreadable"
      | "brand_kit_url_no_palette",
  ) {
    super(message);
    this.name = "SiteBrandingError";
  }
}

/**
 * Read a site's brand via Firecrawl's `branding` format.
 *
 * @throws SiteBrandingError with a code the route maps to a status.
 */
export async function fetchSiteBranding(
  url: URL,
  signal?: AbortSignal,
): Promise<SiteBranding> {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    throw new SiteBrandingError(
      "Building a kit from a website address is not configured on this server. Upload a logo instead.",
      "brand_kit_url_unavailable",
    );
  }

  let response: Response;
  try {
    response = await fetch(FIRECRAWL_SCRAPE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: url.toString(), formats: ["branding"] }),
      signal,
    });
  } catch {
    throw new SiteBrandingError(
      "Couldn't reach that website. Check the address and try again.",
      "brand_kit_url_unreadable",
    );
  }

  const payload = (await response.json().catch(() => null)) as {
    success?: boolean;
    error?: unknown;
    data?: { branding?: unknown };
  } | null;

  if (!response.ok || !payload?.success) {
    throw new SiteBrandingError(
      typeof payload?.error === "string"
        ? payload.error
        : "Couldn't read that website's branding.",
      "brand_kit_url_unreadable",
    );
  }

  const branding = brandingToPalette(payload.data?.branding);
  if (branding.colors.length === 0) {
    throw new SiteBrandingError(
      "No brand colours could be read from that website. Upload a logo instead.",
      "brand_kit_url_no_palette",
    );
  }
  return branding;
}
