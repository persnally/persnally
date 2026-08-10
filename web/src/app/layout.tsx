import type { Metadata } from "next";
import { Instrument_Serif, Newsreader, Geist_Mono } from "next/font/google";
import { OpenPanelComponent } from "@openpanel/nextjs";
import { GITHUB, NPM, PRODUCT_HUNT, SITE } from "@/lib/links";
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
  "Persnally is a local-first personal context engine. It learns who you are from your AI history and serves that context to every AI tool you use — local-first, across every AI.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: "Persnally — your own context engine",
  description,
  applicationName: "Persnally",
  authors: [{ name: "Persnally", url: SITE }],
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
    url: SITE,
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

/* One @graph so the three nodes resolve to the same entity instead of three
   unrelated blobs: who publishes it, what the site is, what the software is.
   No FAQPage — Google dropped FAQ rich results for non-health/gov sites, and
   the page has no visible Q&A for the markup to mirror. */
const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": `${SITE}/#organization`,
      name: "Persnally",
      url: SITE,
      description,
      logo: {
        "@type": "ImageObject",
        url: `${SITE}/icons/android-chrome-512x512.png`,
        width: 512,
        height: 512,
      },
      sameAs: [GITHUB, NPM, PRODUCT_HUNT],
    },
    {
      "@type": "WebSite",
      "@id": `${SITE}/#website`,
      name: "Persnally",
      url: SITE,
      description,
      inLanguage: "en-US",
      publisher: { "@id": `${SITE}/#organization` },
    },
    {
      "@type": "SoftwareApplication",
      "@id": `${SITE}/#software`,
      name: "Persnally",
      applicationCategory: "DeveloperApplication",
      operatingSystem: "macOS, Linux, Windows",
      description,
      url: SITE,
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      license: `${GITHUB}/blob/main/LICENSE`,
      publisher: { "@id": `${SITE}/#organization` },
    },
  ],
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
