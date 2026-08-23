import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// The daemon's API origin during `npm run dev:ui`. The daemon rejects any
// foreign Origin header (DNS-rebinding guard), and http-proxy's changeOrigin
// only rewrites Host — so mutations from the dev server need the Origin
// rewritten too, or every POST 403s.
const DAEMON = "http://127.0.0.1:4983";
const API_PATHS =
  "^/(health|stats|profile|topics|events|voice|activity|questions|scopes|engine|search|skills|ask|feedback|synthesize|consolidate|import)";

export default defineConfig({
  plugins: [viteSingleFile()],
  oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
  build: {
    target: "es2022",
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
  },
  server: {
    host: "127.0.0.1",
    proxy: {
      [API_PATHS]: {
        target: DAEMON,
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReq", (proxyReq) => proxyReq.setHeader("origin", DAEMON));
        },
      },
    },
  },
});
