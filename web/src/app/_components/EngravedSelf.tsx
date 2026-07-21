/* The hero plate: "The Symbolic Head" — a c.1860 phrenology engraving of a
   head whose brain is a life in miniature (Frederick Bridges, Wellcome
   Collection, CC BY 4.0). Persnally's annotations live OUTSIDE the artwork as
   horizontal callouts, so the engraving is never covered; the figure's own
   column is widened (see Hero grid) so it still reads large and bold. */

/* anchors in % of the image box (1000×1118) */
const NOTES: {
  side: "left" | "right";
  x: number;
  y: number;
  title: string;
  detail: string;
  delay: number;
}[] = [
  { side: "right", x: 60, y: 12, title: "interests", detail: "decay-weighted · 0.95", delay: 500 },
  { side: "right", x: 90, y: 40, title: "conventions", detail: "pnpm, not npm", delay: 800 },
  { side: "right", x: 80, y: 66, title: "provenance", detail: "#412 · deletable", delay: 1100 },
  { side: "left", x: 20, y: 46, title: "decisions", detail: '"hand-roll it" · 0.78', delay: 950 },
  { side: "left", x: 15, y: 76, title: "voice", detail: "terse · no emoji", delay: 1250 },
];

/* image takes the middle; labels the outer gutters */
const IMG_LEFT = 15;
const IMG_W = 70;
const contX = (imgX: number) => IMG_LEFT + (imgX * IMG_W) / 100;

export function EngravedSelf() {
  return (
    <figure>
      <div className="relative">
        {/* eslint-disable-next-line @next/next/no-img-element -- static plate, multiply-blended */}
        <img
          src="/art/symbolic-head.webp"
          alt="Engraving of a head in profile whose brain is drawn as dozens of tiny scenes from a life"
          width={1000}
          height={1118}
          className="mx-auto block w-full mix-blend-multiply sm:w-[70%]"
        />
        <div className="hidden sm:block">
          {NOTES.map((n) => {
            const ax = contX(n.x);
            const lineLeft = n.side === "left" ? IMG_LEFT : ax;
            const lineWidth = n.side === "left" ? ax - IMG_LEFT : 100 - IMG_LEFT - ax;
            return (
              <div key={n.title} className="fade-label" style={{ animationDelay: `${n.delay}ms` }}>
                <span
                  aria-hidden
                  className="absolute h-px bg-electric/70"
                  style={{ top: `${n.y}%`, left: `${lineLeft}%`, width: `${lineWidth}%` }}
                />
                <span
                  aria-hidden
                  className="absolute size-[10px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-electric bg-paper"
                  style={{ top: `${n.y}%`, left: `${ax}%` }}
                />
                <span
                  className={`absolute w-[15%] -translate-y-1/2 font-mono leading-snug ${
                    n.side === "left" ? "left-0 pr-1 text-right" : "right-0 pl-1 text-left"
                  }`}
                  style={{ top: `${n.y}%` }}
                >
                  <span className="block text-[13px] font-medium tracking-[0.02em] text-electric">{n.title}</span>
                  <span className="block text-[11px] text-mute">{n.detail}</span>
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <figcaption className="mt-4 flex items-baseline justify-between gap-4 border-t border-ink/30 pt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-mute">
        <span className="whitespace-nowrap">Fig. 1 — a model of you</span>
        <span className="text-right normal-case tracking-normal">
          drawn from your own history · kept on your machine
        </span>
      </figcaption>
    </figure>
  );
}
