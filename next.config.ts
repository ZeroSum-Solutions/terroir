import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(__dirname),
  },
  // LAN testing: phones on the same Wi-Fi hit the dev server via the Mac's
  // IP. Next 16 blocks HMR/dev resource requests from non-localhost origins
  // by default — allow-list our LAN subnet so phone DevTools don't spam.
  allowedDevOrigins: [
    "192.168.50.187",
    "192.168.50.235",
    "192.168.50.0/24",
  ],
};

export default nextConfig;
