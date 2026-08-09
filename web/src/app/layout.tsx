import type { Metadata } from "next";
import { Instrument_Serif, Newsreader, Geist_Mono } from "next/font/google";
import { OpenPanelComponent } from "@openpanel/nextjs";
import "./globals.css";

// OpenPanel client id (public browser key) — kept out of source. Set
// NEXT_PUBLIC_OPENPANEL_CLIENT_ID in .env.local for dev and in your host for prod.
const OPENPANEL_CLIENT_ID = process.env.NEXT_PUBLIC_OPENPANEL_CLIENT_ID;

const display = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  variable: "--font-instrument",
});
const text = Newsreader({ subsets: ["latin"], style: ["normal", "italic"], variable: "--font-newsreader" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

const description =
  "Learns who you are from your AI history and serves that context to every AI you use — Claude, Cursor, Codex. Local-first: your data stays yours.";

export const metadata: Metadata = {
  metadataBase: new URL("https://persnally.com"),
  title: "Persnally — your own context engine",
  description,
  applicationName: "Persnally",
  keywords: ["personal context engine", "local-first", "MCP", "AI memory", "Claude", "ChatGPT", "Cursor"],
  authors: [{ name: "Persnally", url: "https://persnally.com" }],
  creator: "Persnally",
  publisher: "Persnally",
  category: "technology",
  alternates: { canonical: "/" },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
  openGraph: {
    title: "Persnally — so every AI finally knows you",
    description,
    url: "https://persnally.com",
    siteName: "Persnally",
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Persnally — so every AI finally knows you",
    description,
  },
};

// Structured data for rich results (SoftwareApplication: free, BYOK, source-available).
const jsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Persnally",
  applicationCategory: "DeveloperApplication",
  operatingSystem: "macOS, Linux, Windows",
  description,
  url: "https://persnally.com",
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  license: "https://github.com/persnally/persnally/blob/main/LICENSE",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${display.variable} ${text.variable} ${mono.variable}`}>
      <body className="antialiased">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
        {OPENPANEL_CLIENT_ID && (
          <OpenPanelComponent
            clientId={OPENPANEL_CLIENT_ID}
            trackScreenViews
            trackOutgoingLinks
            trackAttributes
          />
        )}
        {children}
      </body>
    </html>
  );
}
