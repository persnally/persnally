"use client";

/* The hero plate: a proportional study of a head in profile, wrapped in its
   measuring grid and construction arcs (Wellcome Collection, public domain —
   the artist's-proportion tradition, not phrenology). The head is the model
   of you, drawn to scale; numbered markers sit on the figure, revealing an
   ink tooltip on hover (desktop) or tap (touch), so the artwork stays
   uncovered at rest. */

import Image from "next/image";
import { useState } from "react";
import head from "../_art/proportion-head.webp";

/* points are coordinates plotted on the model — not head-region claims. Each
   reveals a plain label + a concrete thing Persnally actually learned. */
const POINTS: { x: number; y: number; title: string; detail: string; delay: number }[] = [
  { x: 47, y: 22, title: "what you're into", detail: "local-first systems · weight 0.95", delay: 400 },
  { x: 30, y: 40, title: "how you decide", detail: "“hand-roll it, not a new dep”", delay: 700 },
  { x: 66, y: 72, title: "how you write", detail: "terse · lowercase · no emoji", delay: 1000 },
  { x: 63, y: 49, title: "your conventions", detail: "pnpm, never npm", delay: 1300 },
  { x: 55, y: 36, title: "why it knows", detail: "learned from event #412 · deletable", delay: 1600 },
];

export function EngravedSelf() {
  const [active, setActive] = useState<number | null>(null);

  return (
    <figure>
      <div className="relative bg-paper">
        {/* The page's LCP element — preloaded from the head so it isn't
            discovered only once the body parses. */}
        <Image
          src={head}
          alt="Engraving of a head in profile overlaid with a proportional measuring grid"
          sizes="(min-width: 1024px) 572px, calc(100vw - 3rem)"
          preload
          className="block h-auto w-full mix-blend-multiply"
        />
        {POINTS.map((p, i) => {
          const open = active === i;
          const alignX = p.x > 65 ? "right-0" : p.x < 35 ? "left-0" : "left-1/2 -translate-x-1/2";
          const posY = p.y < 25 ? "top-full mt-2.5" : "bottom-full mb-2.5";
          return (
            <span
              key={p.title}
              /* each marker's transform makes its own stacking context, so a
                 hovered/open point must lift its whole wrapper above the
                 sibling markers or its tooltip gets painted over */
              className={`group fade-label absolute -translate-x-1/2 -translate-y-1/2 hover:z-40 ${open ? "z-40" : "z-10"}`}
              style={{ top: `${p.y}%`, left: `${p.x}%`, animationDelay: `${p.delay}ms` }}
            >
              <button
                type="button"
                aria-label={`${p.title}: ${p.detail}`}
                aria-expanded={open}
                onClick={(e) => {
                  e.currentTarget.focus();
                  setActive((a) => (a === i ? null : i));
                }}
                onBlur={() => setActive((a) => (a === i ? null : a))}
                className="flex size-[21px] cursor-pointer items-center justify-center rounded-full bg-electric font-mono text-[11px] font-bold leading-none text-paper ring-2 ring-paper transition-transform group-hover:scale-110"
              >
                {i + 1}
              </button>
              <span
                role="status"
                className={`absolute ${posY} ${alignX} z-10 w-max max-w-[240px] bg-ink px-3 py-2 font-mono text-[11.5px] leading-snug text-paper transition-opacity duration-150 ${
                  open ? "opacity-100" : "pointer-events-none opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                }`}
              >
                <span className="block text-[10px] uppercase tracking-[0.12em] text-electric-glow">{p.title}</span>
                <span className="mt-0.5 block text-paper">{p.detail}</span>
              </span>
            </span>
          );
        })}
      </div>
      <figcaption className="mt-4 flex items-baseline justify-between gap-4 border-t border-ink/30 pt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-mute">
        <span className="whitespace-nowrap">Fig. 1 — a model of you</span>
        <span className="whitespace-nowrap text-right normal-case tracking-normal">
          your history · your machine
        </span>
      </figcaption>
    </figure>
  );
}
