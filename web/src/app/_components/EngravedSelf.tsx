/* The hero plate: "The Symbolic Head" — a c.1860 phrenology engraving of a
   head whose brain is a life in miniature (Frederick Bridges, Wellcome
   Collection, CC BY 4.0) — annotated with the model Persnally actually
   builds. The scan is flat-fielded to white so multiply-blend melts it into
   the paper; the labels are ours, drawn as an SVG overlay. */

const W = 1100;
const H = 1024;

/* an annotation: anchor ring on the figure + hairline leader + mono label.
   Labels get a paper halo (paint-order stroke) so hatching never runs
   through them. Coordinates are in the artwork's 1100×1024 space. */
function Note({
  anchor,
  elbow,
  at,
  align = "start",
  title,
  detail,
  delay,
}: {
  anchor: [number, number];
  elbow: [number, number];
  at: [number, number];
  align?: "start" | "end";
  title: string;
  detail: string;
  delay: number;
}) {
  const tx = at[0] + (align === "start" ? 10 : -10);
  const halo = {
    paintOrder: "stroke" as const,
    stroke: "var(--color-paper)",
    strokeWidth: 16,
    strokeLinejoin: "round" as const,
  };
  return (
    <g className="fade-label" style={{ animationDelay: `${delay}ms` }}>
      <circle cx={anchor[0]} cy={anchor[1]} r={6} fill="none" stroke="var(--color-electric)" strokeWidth={2.5} />
      <path
        d={`M ${anchor[0]} ${anchor[1]} L ${elbow[0]} ${elbow[1]} L ${at[0]} ${at[1]}`}
        fill="none"
        stroke="var(--color-electric)"
        strokeWidth={1.75}
        opacity={0.8}
      />
      <text
        x={tx}
        y={at[1] - 5}
        textAnchor={align}
        className="font-mono"
        fontSize={27}
        fill="var(--color-electric)"
        style={halo}
      >
        {title}
      </text>
      <text
        x={tx}
        y={at[1] + 27}
        textAnchor={align}
        className="font-mono"
        fontSize={23}
        fill="currentColor"
        opacity={0.75}
        style={halo}
      >
        {detail}
      </text>
    </g>
  );
}

export function EngravedSelf() {
  return (
    <figure>
      {/* bg-paper matters: the hero's entrance animation isolates blending,
          so multiply must find the paper inside this stacking context */}
      <div className="relative bg-paper">
        {/* eslint-disable-next-line @next/next/no-img-element -- static plate, multiply-blended; next/image would re-encode the flattened scan */}
        <img
          src="/art/symbolic-head.webp"
          alt="Engraving of a head in profile whose brain is drawn as dozens of tiny scenes from a life — annotated with the model Persnally builds: interests, decisions, voice, conventions, provenance"
          width={W}
          height={H}
          className="block w-full mix-blend-multiply [filter:brightness(1.07)contrast(0.93)]"
        />
        <svg viewBox={`0 0 ${W} ${H}`} aria-hidden className="absolute inset-0 h-full w-full text-ink">
          <Note
            anchor={[620, 150]}
            elbow={[900, 56]}
            at={[1092, 56]}
            align="end"
            title="interests · decay-weighted"
            detail="local-first systems · 0.95"
            delay={500}
          />
          <Note
            anchor={[912, 500]}
            elbow={[1010, 560]}
            at={[1092, 560]}
            align="end"
            title="conventions"
            detail="pnpm, not npm"
            delay={800}
          />
          <Note
            anchor={[812, 706]}
            elbow={[980, 800]}
            at={[1092, 800]}
            align="end"
            title="provenance"
            detail="event #412 · deletable"
            delay={1100}
          />
          <Note
            anchor={[218, 545]}
            elbow={[110, 620]}
            at={[8, 620]}
            align="start"
            title="decisions"
            detail={'"hand-roll it" · 0.78'}
            delay={950}
          />
          <Note
            anchor={[262, 872]}
            elbow={[140, 952]}
            at={[8, 952]}
            align="start"
            title="voice"
            detail="terse · no emoji"
            delay={1250}
          />
        </svg>
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
