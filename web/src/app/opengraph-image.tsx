import { readFile } from "node:fs/promises";
import { ImageResponse } from "next/og";

export const alt = "Persnally — a model of you, on your machine";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Branded social-share card: ink on paper with the electric accent — the
// engraved-plate identity. Satori bundles no fonts, so the display serif is
// vendored (OFL) and loaded from disk at build time.
export default async function OpengraphImage() {
  const serif = await readFile(new URL("./_fonts/InstrumentSerif-Regular.ttf", import.meta.url));
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#f2efe6",
          color: "#171512",
          fontFamily: '"Instrument Serif", serif',
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 26,
            top: 26,
            width: size.width - 52,
            height: size.height - 52,
            border: "2px solid #171512",
            display: "flex",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 36,
            top: 36,
            width: size.width - 72,
            height: size.height - 72,
            border: "1px solid rgba(23,21,18,0.35)",
            display: "flex",
          }}
        />
        <div
          style={{
            display: "flex",
            fontSize: 24,
            letterSpacing: "0.28em",
            textTransform: "uppercase",
            color: "#57534a",
            marginBottom: 30,
          }}
        >
          No. 1 — A model of you, on your machine
        </div>
        <div style={{ display: "flex", fontSize: 158, letterSpacing: "-0.02em" }}>
          <span>persnally</span>
          <span style={{ color: "#2418ff" }}>.</span>
        </div>
        <div style={{ display: "flex", fontSize: 48, color: "#57534a", marginTop: 26 }}>
          <span>So every AI finally knows&nbsp;</span>
          <span style={{ color: "#2418ff", fontStyle: "italic" }}>you</span>
          <span>.</span>
        </div>
        <div
          style={{
            display: "flex",
            marginTop: 42,
            fontSize: 21,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            color: "#8d8878",
          }}
        >
          drawn from your own history · kept on your machine
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [{ name: "Instrument Serif", data: serif, style: "normal", weight: 400 }],
    },
  );
}
