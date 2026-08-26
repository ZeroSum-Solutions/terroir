import type { Metadata, Viewport } from "next";
import { Archivo, Bodoni_Moda, Courier_Prime } from "next/font/google";
import "./globals.css";

const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
  display: "swap",
});

const bodoni = Bodoni_Moda({
  variable: "--font-bodoni",
  subsets: ["latin"],
  style: ["normal", "italic"],
  display: "swap",
});

const courier = Courier_Prime({
  variable: "--font-courier",
  subsets: ["latin"],
  weight: ["400", "700"],
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
    { media: "(prefers-color-scheme: dark)", color: "#1d1512" },
    { media: "(prefers-color-scheme: light)", color: "#f2ede3" },
  ],
  viewportFit: "cover",
};

/**
 * Applies the stored theme choice before first paint so neither mode
 * flashes. "light" | "dark" set data-theme explicitly; anything else
 * (or no storage access) leaves the system preference in charge via
 * the prefers-color-scheme blocks in globals.css.
 */
const themeInitScript = `try{var t=localStorage.getItem("terroir-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${archivo.variable} ${bodoni.variable} ${courier.variable} h-full overflow-x-clip`}
      suppressHydrationWarning
    >
      <body className="min-h-full">
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        {children}
      </body>
    </html>
  );
}
