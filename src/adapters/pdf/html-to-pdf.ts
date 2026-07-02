import puppeteer from "puppeteer";

export async function renderHtmlToPdf(html: string): Promise<Buffer> {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();
    await page.setContent(html, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    const pdf = await page.pdf({
      format: "Letter",
      printBackground: true,
      timeout: 30_000,
    });

    return Buffer.from(pdf);
  } finally {
    await browser?.close();
  }
}

