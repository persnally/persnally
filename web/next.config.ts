import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Pin the workspace root to this app. Without it, Next walks up and finds a
  // stray ~/package-lock.json, infers $HOME as the root, and Turbopack tries to
  // watch the entire home directory — the source of the dev-server crash.
  turbopack: { root: import.meta.dirname },
};

export default nextConfig;
