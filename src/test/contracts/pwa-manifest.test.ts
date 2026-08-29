import { describe, expect, it } from "vitest";

describe("PWA manifest contract", () => {
  it("describes the installable Terroir app and its required icons", async () => {
    const { default: manifest } = await import("../../app/manifest");

    expect(manifest()).toEqual({
      name: "Terroir",
      short_name: "Terroir",
      description: "Wine management for upscale restaurants.",
      start_url: "/",
      display: "standalone",
      background_color: "#F4F5F6",
      theme_color: "#F4F5F6",
      icons: [
        {
          src: "/icons/icon-192.png",
          sizes: "192x192",
          type: "image/png",
        },
        {
          src: "/icons/icon-512.png",
          sizes: "512x512",
          type: "image/png",
        },
        {
          src: "/icons/icon-maskable-512.png",
          sizes: "512x512",
          type: "image/png",
          purpose: "maskable",
        },
      ],
    });
  });
});
