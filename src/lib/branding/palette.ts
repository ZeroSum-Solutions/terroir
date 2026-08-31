import puppeteer from "puppeteer";
import { inflateSync } from "node:zlib";

type Bucket = {
  count: number;
  red: number;
  green: number;
  blue: number;
};

const RASTER_SIZE = 64;

export async function extractPaletteFromImage(
  bytes: Buffer,
  mimeType: string,
): Promise<string[]> {
  if (mimeType === "image/png") {
    try {
      return quantizeDominantColours(decodePng(bytes));
    } catch {
      // LIST-05 — the hand-rolled decoder handles only non-interlaced 8-bit
      // truecolour PNGs. An *indexed* PNG (colour type 3) is what most design
      // tools export a logo as, and it threw here, which is a large part of
      // "the brand kit doesn't work". Chromium reads every PNG variant, so
      // fall through to the rasterizer rather than blaming the file.
    }
  }
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  try {
    const page = await browser.newPage();
    const source = `data:${mimeType};base64,${bytes.toString("base64")}`;
    const pixels = await page.evaluate(rasterizeImage, {
      source,
      size: RASTER_SIZE,
    });
    return quantizeDominantColours(pixels);
  } finally {
    await browser.close();
  }
}

function decodePng(bytes: Buffer): number[] {
  const signature = bytes.subarray(0, 8);
  if (!signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error("Invalid PNG signature.");
  }
  let width = 0;
  let height = 0;
  let colourType = -1;
  const compressed: Buffer[] = [];
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error("Unsupported PNG format.");
      colourType = data[9];
    } else if (type === "IDAT") compressed.push(data);
    offset += length + 12;
  }
  const channels = colourType === 6 ? 4 : colourType === 2 ? 3 : 0;
  if (!channels || width < 1 || height < 1 || width > 1024 || height > 1024) {
    throw new Error("Unsupported PNG dimensions or colour type.");
  }
  const rowBytes = width * channels;
  const raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: 5 * 1024 * 1024 });
  if (raw.length !== (rowBytes + 1) * height) throw new Error("Invalid PNG pixel data.");
  return unfilterPng(raw, width, height, channels);
}

function unfilterPng(raw: Buffer, width: number, height: number, channels: number): number[] {
  const rowBytes = width * channels;
  const pixels: number[] = [];
  let previous = Buffer.alloc(rowBytes);
  for (let row = 0; row < height; row += 1) {
    const start = row * (rowBytes + 1);
    const filter = raw[start];
    const current = Buffer.alloc(rowBytes);
    for (let index = 0; index < rowBytes; index += 1) {
      const value = raw[start + 1 + index];
      const left = index >= channels ? current[index - channels] : 0;
      const above = previous[index];
      const upperLeft = index >= channels ? previous[index - channels] : 0;
      current[index] = (value + filterValue(filter, left, above, upperLeft)) & 255;
    }
    for (let index = 0; index < rowBytes; index += channels) {
      pixels.push(current[index], current[index + 1], current[index + 2], channels === 4 ? current[index + 3] : 255);
    }
    previous = current;
  }
  return pixels;
}

function filterValue(filter: number, left: number, above: number, upperLeft: number): number {
  if (filter === 0) return 0;
  if (filter === 1) return left;
  if (filter === 2) return above;
  if (filter === 3) return Math.floor((left + above) / 2);
  if (filter === 4) return paeth(left, above, upperLeft);
  throw new Error("Unsupported PNG filter.");
}

function paeth(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

async function rasterizeImage(input: {
  source: string;
  size: number;
}): Promise<number[]> {
  const image = new Image();
  image.src = input.source;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = input.size;
  canvas.height = input.size;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Could not create image canvas.");
  context.imageSmoothingEnabled = false;
  context.drawImage(image, 0, 0, input.size, input.size);
  return Array.from(context.getImageData(0, 0, input.size, input.size).data);
}

export function quantizeDominantColours(pixels: number[]): string[] {
  const buckets = new Map<number, Bucket>();
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (pixels[offset + 3] < 128) continue;
    const red = pixels[offset];
    const green = pixels[offset + 1];
    const blue = pixels[offset + 2];
    const key = (red >> 5) << 10 | (green >> 5) << 5 | (blue >> 5);
    const bucket = buckets.get(key) ?? { count: 0, red: 0, green: 0, blue: 0 };
    bucket.count += 1;
    bucket.red += red;
    bucket.green += green;
    bucket.blue += blue;
    buckets.set(key, bucket);
  }

  return [...buckets.values()]
    .map((bucket) => ({
      count: bucket.count,
      colour: toHex(
        Math.round(bucket.red / bucket.count),
        Math.round(bucket.green / bucket.count),
        Math.round(bucket.blue / bucket.count),
      ),
    }))
    .sort((left, right) => right.count - left.count || left.colour.localeCompare(right.colour))
    .slice(0, 6)
    .map((bucket) => bucket.colour);
}

function toHex(red: number, green: number, blue: number): string {
  return `#${[red, green, blue]
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`.toUpperCase();
}
