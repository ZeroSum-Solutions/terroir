import puppeteer from "puppeteer";

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("PDF rendering aborted");
  }
}

async function withAbort<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return task;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("PDF rendering aborted"));
    signal.addEventListener("abort", abort, { once: true });
    task.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export async function renderHtmlToPdf(
  html: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  let browser;
  try {
    throwIfAborted(signal);
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    throwIfAborted(signal);
    const page = await browser.newPage();
    await withAbort(
      page.setContent(html, {
        waitUntil: "domcontentloaded",
        timeout: 20_000,
      }),
      signal,
    );
    const pdf = await withAbort(
      page.pdf({
        format: "Letter",
        printBackground: true,
        timeout: 30_000,
      }),
      signal,
    );

    return Buffer.from(pdf);
  } finally {
    await browser?.close();
  }
}
