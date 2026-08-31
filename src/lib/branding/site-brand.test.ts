import { describe, expect, it } from "vitest";
import {
  brandingToPalette,
  safeLogoUrl,
  validateBusinessUrl,
} from "./site-brand";

describe("validateBusinessUrl", () => {
  it("accepts a bare domain and normalises it to https", () => {
    const result = validateBusinessUrl(" thefrenchlaundry.com ");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.url.toString()).toBe("https://thefrenchlaundry.com/");
  });

  it("keeps a path and an explicit scheme", () => {
    const result = validateBusinessUrl("http://example.com/about");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.url.toString()).toBe("http://example.com/about");
  });

  it.each([
    ["", "empty"],
    ["file:///etc/passwd", "file scheme"],
    ["javascript:alert(1)", "javascript scheme"],
    ["ftp://example.com", "ftp scheme"],
    ["http://user:pass@example.com", "embedded credentials"],
    ["http://localhost:3000", "loopback name"],
    ["http://127.0.0.1", "loopback v4"],
    ["http://0.0.0.0", "unspecified v4"],
    ["https://10.1.2.3", "RFC1918 10/8"],
    ["https://172.16.0.9", "RFC1918 172.16/12"],
    ["https://192.168.0.1", "RFC1918 192.168/16"],
    ["https://169.254.169.254/latest/meta-data", "link-local metadata"],
    ["https://100.64.0.1", "carrier-grade NAT"],
    ["https://[::1]", "loopback v6"],
    ["https://[fd00::1]", "unique-local v6"],
    ["https://[fe80::1]", "link-local v6"],
    ["https://printer.local", "mDNS name"],
    ["https://db.internal", "internal name"],
    ["https://intranet", "bare hostname"],
    // Non-canonical IPv4 spellings — WHATWG URL normalises these to plain
    // dotted-quad, so the ordinary IPv4 branch already catches them. Pinned
    // here so a future refactor can't quietly lose that.
    ["https://127.1", "short-form loopback v4"],
    ["https://0x7f.1", "hex-form loopback v4"],
    ["https://2130706433", "decimal loopback v4"],
    ["https://192.168.1", "short-form RFC1918 v4"],
    // IPv6-mapped IPv4 — the gap the IPv4 regex alone cannot see, because
    // the bracket-stripped hostname never contains four dotted octets.
    ["https://[::ffff:127.0.0.1]", "IPv6-mapped loopback (dotted)"],
    ["https://[::ffff:7f00:1]", "IPv6-mapped loopback (hex-compressed)"],
    ["https://[::ffff:169.254.169.254]", "IPv6-mapped metadata host (dotted)"],
    ["https://[::ffff:a9fe:a9fe]", "IPv6-mapped metadata host (hex-compressed)"],
    ["https://[::ffff:10.0.0.1]", "IPv6-mapped RFC1918 (dotted)"],
    ["https://[::ffff:a00:1]", "IPv6-mapped RFC1918 (hex-compressed)"],
    ["https://[0:0:0:0:0:ffff:127.0.0.1]", "IPv6-mapped loopback (fully expanded, dotted)"],
    ["https://[0:0:0:0:0:ffff:7f00:1]", "IPv6-mapped loopback (fully expanded, hex)"],
  ])("refuses %s (%s)", (input) => {
    expect(validateBusinessUrl(input).ok).toBe(false);
  });
});

describe("brandingToPalette", () => {
  it("maps Firecrawl's colour roles into ordered, deduped swatches", () => {
    const result = brandingToPalette({
      colors: {
        primary: "#ff4c00",
        accent: "#FF4C00",
        background: "#F9F9F9",
        textPrimary: "not-a-colour",
        link: "#FF4D00",
      },
      images: { logo: "https://example.com/logo.png" },
    });

    expect(result.colors).toEqual(["#FF4C00", "#F9F9F9", "#FF4D00"]);
    expect(result.logoUrl).toBe("https://example.com/logo.png");
  });

  it("caps at the six the palette schema allows", () => {
    const result = brandingToPalette({
      colors: {
        primary: "#111111",
        secondary: "#222222",
        accent: "#333333",
        background: "#444444",
        textPrimary: "#555555",
        link: "#666666",
      },
    });
    expect(result.colors).toHaveLength(6);
  });

  it("returns nothing usable for a payload with no colours", () => {
    expect(brandingToPalette(null)).toEqual({ colors: [], logoUrl: null });
    expect(brandingToPalette({ colors: {} })).toEqual({ colors: [], logoUrl: null });
  });
});

describe("safeLogoUrl", () => {
  it.each([
    "javascript:alert(1)",
    "http://example.com/logo.png",
    "//example.com/logo.png",
    "",
  ])("refuses %j", (candidate) => {
    expect(safeLogoUrl(candidate)).toBeNull();
  });

  it("accepts an inline image and an https image", () => {
    expect(safeLogoUrl("data:image/png;base64,aaa")).toBe("data:image/png;base64,aaa");
    expect(safeLogoUrl("https://example.com/logo.svg")).toBe(
      "https://example.com/logo.svg",
    );
  });

  it("refuses a logo too large to store", () => {
    expect(safeLogoUrl(`data:image/png;base64,${"a".repeat(3 * 1024 * 1024)}`)).toBeNull();
  });

  it.each([
    "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
    "data:image/svg+xml,<svg onload=alert(1)></svg>",
    "data:image/SVG+XML;base64,PHN2Zz48L3N2Zz4=",
  ])("refuses an SVG data URI %j — SVG carries active content", (candidate) => {
    expect(safeLogoUrl(candidate)).toBeNull();
  });

  it.each([
    "https://127.0.0.1/logo.png",
    "https://169.254.169.254/logo.png",
    "https://10.0.0.5/logo.png",
    "https://[::ffff:127.0.0.1]/logo.png",
    "https://[::ffff:169.254.169.254]/logo.png",
    "https://internal.local/logo.png",
  ])("refuses a logo URL on a private host %j (finding C)", (candidate) => {
    expect(safeLogoUrl(candidate)).toBeNull();
  });
});
