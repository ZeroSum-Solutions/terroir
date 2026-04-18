import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  serverExternalPackages: ["puppeteer", "@anthropic-ai/sdk"],
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
