"use client";

/* The hero plate: "The Symbolic Head" — a c.1860 phrenology engraving of a
   head whose brain is a life in miniature (Frederick Bridges, Wellcome
   Collection, public domain). Numbered markers sit on the figure like the
   plate's own keyed regions; the label reveals on hover (desktop) or tap
   (touch) as an ink tooltip, so the artwork stays uncovered at rest. */

import { useState } from "react";

const POINTS: { x: number; y: number; title: string; detail: string; delay: number }[] = [
  { x: 60, y: 12, title: "interests", detail: "decay-weighted 0.95", delay: 400 },
  { x: 20, y: 46, title: "decisions", detail: "“hand-roll it” 0.78", delay: 700 },
  { x: 15, y: 76, title: "voice", detail: "terse no-emoji", delay: 1000 },
  { x: 90, y: 40, title: "conventions", detail: "pnpm not-npm", delay: 1300 },
  { x: 80, y: 66, title: "provenance", detail: "#412 deletable", delay: 1600 },
];

export function EngravedSelf() {
  const [active, setActive] = useState<number | null>(null);

  return (
    <figure>
      <div className="relative bg-paper">
        {/* eslint-disable-next-line @next/next/no-img-element -- static plate, multiply-blended */}
        <img
          src="/art/symbolic-head.webp"
          alt="Engraving of a head in profile whose brain is drawn as dozens of tiny scenes from a life"
          width={1000}
          height={1118}
          className="block w-full mix-blend-multiply"
        />
        {POINTS.map((p, i) => {
          const open = active === i;
          /* keep tooltips inside the plate: edge markers anchor toward the middle */
          const alignX = p.x > 65 ? "right-0" : p.x < 35 ? "left-0" : "left-1/2 -translate-x-1/2";
          const posY = p.y < 25 ? "top-full mt-2.5" : "bottom-full mb-2.5";
          return (
            <span
              key={p.title}
              className="group fade-label absolute -translate-x-1/2 -translate-y-1/2"
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
                className={`absolute ${posY} ${alignX} z-10 whitespace-nowrap bg-ink px-3 py-2 font-mono text-[11.5px] leading-tight text-paper transition-opacity duration-150 ${
                  open ? "opacity-100" : "pointer-events-none opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                }`}
              >
                <span className="text-electric-glow">{p.title}</span> {p.detail}
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
