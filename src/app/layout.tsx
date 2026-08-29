import type { Metadata, Viewport } from "next";
import { Ephesis, Source_Code_Pro, Source_Sans_3, Source_Serif_4 } from "next/font/google";
import "./globals.css";

/**
 * Nocturne's four faces (DESIGN.md — Typography). Source Serif 4, Source
 * Sans 3 and Source Code Pro were drawn as one superfamily, which is why they
 * sit together without negotiation. Bodoni Moda, Archivo and Courier Prime are
 * retired: a Didone's defining feature is extreme stroke contrast, and on a
 * near-black ground light type irradiates outward and eats exactly those
 * hairlines.
 */
const sourceSerif = Source_Serif_4({
  variable: "--font-source-serif",
  subsets: ["latin"],
  // The optical-size axis is the reason this face was chosen: one family
  // redraws itself for a 13px caption and a 72px hero.
  axes: ["opsz"],
  style: ["normal", "italic"],
  display: "swap",
});

const sourceSans = Source_Sans_3({
  variable: "--font-source-sans",
  subsets: ["latin"],
  display: "swap",
});

const sourceCode = Source_Code_Pro({
  variable: "--font-source-code",
  subsets: ["latin"],
  display: "swap",
});

const ephesis = Ephesis({
  variable: "--font-ephesis",
  subsets: ["latin"],
  weight: "400",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    template: "%s · Terroir",
    default: "Terroir",
  },
  description: "Wine management for upscale restaurants.",
  appleWebApp: {
    capable: true,
    title: "Terroir",
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#07080A" },
    { media: "(prefers-color-scheme: light)", color: "#F4F5F6" },
  ],
  viewportFit: "cover",
};

/**
 * Applies the stored theme choice before first paint so neither mode
 * flashes. "light" | "dark" set data-theme explicitly; anything else
 * (or no storage access) leaves the system preference in charge via
 * the prefers-color-scheme blocks in globals.css. An explicit choice
 * also overrides both theme-color metas so browser/PWA chrome matches
 * the page rather than the system scheme (ThemeToggle keeps them in
 * sync on later changes; hexes hand-synced with viewport.themeColor).
 */
const themeInitScript = `try{var t=localStorage.getItem("terroir-theme");if(t==="light"||t==="dark"){document.documentElement.dataset.theme=t;var c=t==="dark"?"#07080A":"#F4F5F6";document.querySelectorAll('meta[name="theme-color"]').forEach(function(m){m.setAttribute("content",c)})}}catch(e){}`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${sourceSans.variable} ${sourceSerif.variable} ${sourceCode.variable} ${ephesis.variable} h-full overflow-x-clip`}
      suppressHydrationWarning
    >
      <body className="min-h-full">
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        {children}
      </body>
    </html>
  );
}
