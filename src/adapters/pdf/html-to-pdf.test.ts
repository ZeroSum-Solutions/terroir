// Contract tests for the html-to-pdf adapter — §3.4 of the refactor plan.
//
// The behavior worth pinning here is not the happy path, it is the
// `finally { await browser?.close() }`. Puppeteer holds a real OS process;
// if a throw from setContent or page.pdf ever skipped the close, the app
// would leak a Chromium per failed render until the container died. That
// is invisible to a mocked call site, which is how every current caller
// exercises this module.
import { beforeEach, describe, expect, it, vi } from "vitest";

const launch = vi.fn();
vi.mock("puppeteer", () => ({ default: { launch: (...a: unknown[]) => launch(...a) } }));

const { renderHtmlToPdf } = await import("./html-to-pdf");

function browserStub(overrides?: { setContent?: () => Promise<void>; pdf?: () => Promise<Uint8Array> }) {
  const close = vi.fn().mockResolvedValue(undefined);
  const setContent = vi.fn(overrides?.setContent ?? (async () => {}));
  const pdf = vi.fn(overrides?.pdf ?? (async () => new Uint8Array([37, 80, 68, 70])));
  const newPage = vi.fn().mockResolvedValue({ setContent, pdf });
  return { browser: { newPage, close }, close, setContent, pdf, newPage };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("renderHtmlToPdf", () => {
  it("returns a Buffer of the rendered bytes", async () => {
    const stub = browserStub();
    launch.mockResolvedValue(stub.browser);

    const out = await renderHtmlToPdf("<h1>hi</h1>");

    expect(Buffer.isBuffer(out)).toBe(true);
    expect(Array.from(out)).toEqual([37, 80, 68, 70]);
  });

  it("launches headless with the sandbox flags the container needs", async () => {
    const stub = browserStub();
    launch.mockResolvedValue(stub.browser);

    await renderHtmlToPdf("<p>x</p>");

    expect(launch).toHaveBeenCalledWith({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  });

  it("renders Letter with backgrounds, under an explicit timeout", async () => {
    const stub = browserStub();
    launch.mockResolvedValue(stub.browser);

    await renderHtmlToPdf("<p>x</p>");

    expect(stub.setContent).toHaveBeenCalledWith("<p>x</p>", { waitUntil: "domcontentloaded", timeout: 20_000 });
    expect(stub.pdf).toHaveBeenCalledWith({ format: "Letter", printBackground: true, timeout: 30_000 });
  });

  it("closes the browser when rendering succeeds", async () => {
    const stub = browserStub();
    launch.mockResolvedValue(stub.browser);

    await renderHtmlToPdf("<p>x</p>");

    expect(stub.close).toHaveBeenCalledTimes(1);
  });

  it("closes the browser when setContent throws", async () => {
    const stub = browserStub({ setContent: async () => { throw new Error("bad html"); } });
    launch.mockResolvedValue(stub.browser);

    await expect(renderHtmlToPdf("<p>x</p>")).rejects.toThrow("bad html");
    expect(stub.close).toHaveBeenCalledTimes(1);
  });

  it("closes the browser when pdf generation throws", async () => {
    const stub = browserStub({ pdf: async () => { throw new Error("render timeout"); } });
    launch.mockResolvedValue(stub.browser);

    await expect(renderHtmlToPdf("<p>x</p>")).rejects.toThrow("render timeout");
    expect(stub.close).toHaveBeenCalledTimes(1);
  });

  it("propagates a launch failure without trying to close an undefined browser", async () => {
    // `browser` is still undefined when launch itself rejects; the optional
    // chain in the finally block is what stops this becoming a TypeError
    // that masks the real failure.
    launch.mockRejectedValue(new Error("no chromium"));

    await expect(renderHtmlToPdf("<p>x</p>")).rejects.toThrow("no chromium");
  });
});
