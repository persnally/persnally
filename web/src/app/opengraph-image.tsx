import { readFile } from "node:fs/promises";
import { ImageResponse } from "next/og";

export const alt = "Persnally — your own context engine";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/* The mark on paper, centred, and nothing else. Social cards render at every
   size from a thumbnail up; a mark survives that, engraved rules and 24px
   letter-spaced eyebrows do not. The title and description come from the
   metadata beside the card anyway, so repeating them inside it spent the whole
   frame saying the same thing twice.

   The SVG is inlined as a data URI because Satori resolves no relative paths. */
export default async function OpengraphImage() {
  const mark = await readFile(new URL("../../public/brand/persnally-mark.svg", import.meta.url), "utf-8");
  const src = `data:image/svg+xml;base64,${Buffer.from(mark).toString("base64")}`;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#f2efe6",
        }}
      >
        <img src={src} width={320} height={320} alt="" />
      </div>
    ),
    { ...size },
  );
}
