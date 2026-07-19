/* The hero plate: "The Symbolic Head" — a c.1860 phrenology engraving of a
   head whose brain is a life in miniature (Frederick Bridges, Wellcome
   Collection, CC BY 4.0). Cropped to the head alone (the plate's own arch
   lettering erased in processing); Persnally's annotations live OUTSIDE the
   artwork as horizontal callouts, so the engraving stays untouched. */

/* image is 1000×1118; anchors in % of the image box */
const NOTES: {
  side: "left" | "right";
  x: number; // anchor x, % of image
  y: number; // anchor y, % of image
  title: string;
  detail: string;
  delay: number;
}[] = [
  { side: "right", x: 58, y: 13, title: "interests", detail: "decay-weighted · 0.95", delay: 500 },
  { side: "right", x: 89, y: 40, title: "conventions", detail: "pnpm, not npm", delay: 800 },
  { side: "right", x: 77, y: 68, title: "provenance", detail: "#412 · deletable", delay: 1100 },
  { side: "left", x: 15, y: 44, title: "decisions", detail: '"hand-roll it" · 0.78', delay: 950 },
  { side: "left", x: 14.5, y: 76.5, title: "voice", detail: "terse · no emoji", delay: 1250 },
];

/* image occupies the middle 68% of the figure; labels take the outer 16% */
const IMG_LEFT = 16;
const IMG_W = 68;
const contX = (imgX: number) => IMG_LEFT + (imgX * IMG_W) / 100;

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
          className="mx-auto block w-full mix-blend-multiply sm:w-[68%]"
        />
        <div className="hidden sm:block">
          {NOTES.map((n) => {
            const ax = contX(n.x);
            const lineLeft = n.side === "left" ? 15 : ax;
            const lineWidth = n.side === "left" ? ax - 15 : 85 - ax;
            return (
              <div key={n.title} className="fade-label" style={{ animationDelay: `${n.delay}ms` }}>
                <span
                  aria-hidden
                  className="absolute h-px bg-electric/70"
                  style={{ top: `${n.y}%`, left: `${lineLeft}%`, width: `${lineWidth}%` }}
                />
                <span
                  aria-hidden
                  className="absolute size-[9px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px] border-electric bg-paper"
                  style={{ top: `${n.y}%`, left: `${ax}%` }}
                />
                <span
                  className={`absolute w-[14.5%] -translate-y-1/2 font-mono leading-snug ${
                    n.side === "left" ? "left-0 pr-1 text-right" : "right-0 pl-1 text-left"
                  }`}
                  style={{ top: `${n.y}%` }}
                >
                  <span className="block text-[12px] tracking-[0.04em] text-electric">{n.title}</span>
                  <span className="block text-[11px] text-mute">{n.detail}</span>
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <figcaption className="mt-3 flex items-baseline justify-between gap-4 border-t border-ink/30 pt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-mute">
        <span className="whitespace-nowrap">Fig. 1 — a model of you</span>
        <span className="text-right normal-case tracking-normal">
          drawn from your own history · kept on your machine
        </span>
      </figcaption>
    </figure>
  );
}
