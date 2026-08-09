import type { MetadataRoute } from "next";

/* The generated bundle shipped an empty name and a white theme, which would
   install as an untitled app that flashes white against the paper field. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Persnally — your own context engine",
    short_name: "Persnally",
    description:
      "A local-first personal context engine. Learns who you are from your AI history and serves it to every AI you use — on your machine.",
    start_url: "/",
    display: "standalone",
    background_color: "#f2efe6",
    theme_color: "#f2efe6",
    icons: [
      { src: "/icons/android-chrome-192x192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/android-chrome-512x512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
