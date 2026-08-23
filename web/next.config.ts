import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Pin the workspace root to this app. Without it, Next walks up and finds a
  // stray ~/package-lock.json, infers $HOME as the root, and Turbopack tries to
  // watch the entire home directory — the source of the dev-server crash.
  turbopack: { root: import.meta.dirname },
  images: {
    // The engravings are the page's whole weight. AVIF first, WebP for the
    // browsers that lack it; the sources are WebP already, so this is the last
    // ~20% after the resizing win.
    formats: ["image/avif", "image/webp"],
    // No plate is drawn wider than 572 CSS px (the hero) or narrower than a
    // 80px map slice, so the default ladder's outer rungs are dead srcset
    // bytes and dead billable transformations. Widen before a full-bleed image.
    deviceSizes: [640, 750, 828, 1080, 1200, 1920],
    imageSizes: [128, 256, 384],
  },
};

export default nextConfig;
