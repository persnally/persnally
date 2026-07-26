/* The hero plate: "The Symbolic Head" — a c.1860 phrenology engraving of a
   head whose brain is a life in miniature (Frederick Bridges, Wellcome
   Collection, public domain). The plate's own visual language is numbered
   regions keyed to a legend — so our annotations use the same grammar:
   numbered anchor points on the figure, a legend under the plate rule.
   Nothing covers the artwork, and the engraving runs full width. */

const POINTS: { x: number; y: number; title: string; detail: string; delay: number }[] = [
  { x: 60, y: 12, title: "interests", detail: "decay-weighted · 0.95", delay: 400 },
  { x: 20, y: 46, title: "decisions", detail: "“hand-roll it” · 0.78", delay: 700 },
  { x: 15, y: 76, title: "voice", detail: "terse · no emoji", delay: 1000 },
  { x: 90, y: 40, title: "conventions", detail: "pnpm, not npm", delay: 1300 },
  { x: 80, y: 66, title: "provenance", detail: "#412 · deletable", delay: 1600 },
];

export function EngravedSelf() {
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
        {POINTS.map((p, i) => (
          <span
            key={p.title}
            aria-hidden
            className="fade-label absolute flex size-[19px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-electric font-mono text-[11px] font-bold leading-none text-paper ring-2 ring-paper"
            style={{ top: `${p.y}%`, left: `${p.x}%`, animationDelay: `${p.delay}ms` }}
          >
            {i + 1}
          </span>
        ))}
      </div>
      <figcaption className="mt-4 border-t border-ink/30 pt-3">
        <div className="flex flex-wrap gap-x-5 gap-y-1.5 font-mono text-[11.5px] leading-snug">
          {POINTS.map((p, i) => (
            <span key={p.title} className="whitespace-nowrap">
              <span className="mr-1.5 inline-flex size-[15px] items-center justify-center rounded-full bg-electric text-[9.5px] font-bold text-paper">
                {i + 1}
              </span>
              <span className="text-ink">{p.title}</span>
              <span className="text-mute"> · {p.detail}</span>
            </span>
          ))}
        </div>
        <div className="mt-3 flex items-baseline justify-between gap-4 font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
          <span className="whitespace-nowrap">Fig. 1 — a model of you</span>
          <span className="whitespace-nowrap text-right normal-case tracking-normal">
            your history · your machine
          </span>
        </div>
      </figcaption>
    </figure>
  );
}
