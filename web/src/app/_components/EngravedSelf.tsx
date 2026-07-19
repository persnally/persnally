/* The hero plate: an engraving-style profile head built from hatched SVG lines,
   annotated like an anatomical diagram — except the regions are the model
   Persnally actually builds (interests, voice, decisions, provenance).
   Pure SVG, deterministic, no WebGL: renders everywhere, honest and local. */

const W = 680;
const H = 700;

/* Left-facing classical profile, drawn clockwise from the crown; the bust
   exits through the bottom of the plate like a museum engraving. */
const HEAD =
  "M 320 122 " +
  "C 258 134 228 176 220 232 " + // forehead, sloping back
  "C 218 252 212 268 202 282 " + // brow ridge
  "C 196 292 186 312 176 330 " + // nose bridge → tip
  "C 172 340 174 348 184 351 " + // nose underside
  "C 192 353 196 358 194 366 " + // philtrum
  "C 186 372 185 383 193 388 " + // upper lip
  "C 201 392 202 397 196 402 " + // lip parting
  "C 187 409 187 421 197 427 " + // lower lip
  "C 205 431 207 439 202 447 " + // above chin
  "C 198 460 206 476 222 482 " + // chin ball
  "C 246 490 274 510 296 538 " + // under-jaw sweeping back
  "C 306 552 310 560 314 574 " + // throat notch
  "C 315 590 312 640 310 700 " + // front of neck to plate edge
  "L 452 700 " + //                 bottom edge
  "C 450 640 448 600 452 570 " + // back of neck rising
  "C 456 546 470 522 486 500 " + // nape curve
  "C 510 462 522 408 520 352 " + // back of skull, lower
  "C 520 270 492 186 428 142 " + // back of skull, upper
  "C 396 122 352 116 320 122 " + // domed crown to apex
  "Z";

/* deterministic pseudo-noise so the hatching feels hand-pulled, not plotted */
const wob = (i: number, k: number) => Math.sin(i * 12.9898 + k * 78.233) * 1.6;

function Hatching() {
  const lines = [];
  for (let i = 0; i < 82; i++) {
    const y = 126 + i * 7;
    // lines bow around the skull's volume; bulge peaks mid-skull
    const bulge = 10 * Math.sin(((y - 120) / (H - 160)) * Math.PI);
    // shading: light at the brow (front-top), dense toward nape and under-jaw
    const opacity = 0.28 + 0.34 * Math.min(1, Math.max(0, (y - 180) / 420));
    lines.push(
      <path
        key={i}
        d={`M 140 ${y + wob(i, 1)} Q ${W / 2} ${y + bulge + wob(i, 2)} 560 ${y + wob(i, 3)}`}
        stroke="currentColor"
        strokeWidth={0.8}
        opacity={opacity}
        fill="none"
      />,
    );
  }
  return <g clipPath="url(#head)">{lines}</g>;
}

/* diagonal cross-hatch, masked to the shadow side (nape, under-jaw) */
function CrossHatch() {
  const lines = [];
  for (let i = 0; i < 48; i++) {
    const x = 280 + i * 7;
    lines.push(
      <line
        key={i}
        x1={x + wob(i, 4)}
        y1={160}
        x2={x - 140}
        y2={700}
        stroke="currentColor"
        strokeWidth={0.7}
        opacity={0.2}
      />,
    );
  }
  return (
    <g clipPath="url(#head)" mask="url(#shadow)">
      {lines}
    </g>
  );
}

/* engraved glory: thin rays radiating from behind the head */
function Burst() {
  const cx = 348;
  const cy = 340;
  const rays = [];
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * Math.PI * 2;
    const r0 = 232 + (i % 3) * 9;
    const r1 = i % 6 === 0 ? 298 : 272;
    rays.push(
      <line
        key={i}
        x1={cx + Math.cos(a) * r0}
        y1={cy + Math.sin(a) * r0}
        x2={cx + Math.cos(a) * r1}
        y2={cy + Math.sin(a) * r1}
        stroke="currentColor"
        strokeWidth={0.6}
        opacity={0.3}
      />,
    );
  }
  return <g>{rays}</g>;
}

/* an annotation: anchor ring on the figure + hairline leader + mono label.
   Labels get a paper halo (paint-order stroke) so rays never run through them. */
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
  const tx = at[0] + (align === "start" ? 6 : -6);
  const halo = {
    paintOrder: "stroke" as const,
    stroke: "var(--color-paper)",
    strokeWidth: 8,
    strokeLinejoin: "round" as const,
  };
  return (
    <g className="fade-label" style={{ animationDelay: `${delay}ms` }}>
      <circle cx={anchor[0]} cy={anchor[1]} r={2.5} fill="none" stroke="currentColor" strokeWidth={1} />
      <path
        d={`M ${anchor[0]} ${anchor[1]} L ${elbow[0]} ${elbow[1]} L ${at[0]} ${at[1]}`}
        fill="none"
        stroke="currentColor"
        strokeWidth={0.75}
        opacity={0.55}
      />
      <text x={tx} y={at[1] - 3} textAnchor={align} className="font-mono" fontSize={10.5} fill="currentColor" style={halo}>
        {title}
      </text>
      <text
        x={tx}
        y={at[1] + 11}
        textAnchor={align}
        className="font-mono"
        fontSize={10.5}
        fill="currentColor"
        opacity={0.6}
        style={halo}
      >
        {detail}
      </text>
    </g>
  );
}

export function EngravedSelf() {
  return (
    <figure className="plate-double p-4 sm:p-6">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Engraved diagram of a head in profile, annotated with the model Persnally builds: interests, decisions, voice, conventions, provenance"
        className="block w-full text-ink"
      >
        <Burst />
        {/* paper fill knocks the burst out behind the figure */}
        <path d={HEAD} fill="var(--color-paper)" />
        <defs>
          <clipPath id="head">
            <path d={HEAD} />
          </clipPath>
          <mask id="shadow">
            <rect width={W} height={H} fill="black" />
            {/* nape + neck catch the cross-hatch; keep it off the face */}
            <ellipse cx={508} cy={390} rx={58} ry={190} fill="white" transform="rotate(6 508 390)" />
            <ellipse cx={356} cy={610} rx={120} ry={100} fill="white" />
          </mask>
        </defs>
        <Hatching />
        <CrossHatch />
        <path
          d={HEAD}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.6}
          pathLength={1}
          className="engrave-line"
        />

        <Note
          anchor={[382, 158]}
          elbow={[460, 78]}
          at={[648, 78]}
          align="end"
          title="interests · decay-weighted"
          detail="local-first systems · 0.95"
          delay={700}
        />
        <Note
          anchor={[221, 254]}
          elbow={[130, 190]}
          at={[30, 190]}
          align="start"
          title="decisions"
          detail={'"hand-roll it" · conf 0.78'}
          delay={900}
        />
        <Note
          anchor={[196, 412]}
          elbow={[112, 478]}
          at={[30, 478]}
          align="start"
          title="voice"
          detail="terse · lowercase · no emoji"
          delay={1100}
        />
        <Note
          anchor={[514, 310]}
          elbow={[576, 250]}
          at={[648, 250]}
          align="end"
          title="conventions"
          detail="pnpm, not npm"
          delay={1300}
        />
        <Note
          anchor={[448, 630]}
          elbow={[540, 596]}
          at={[648, 596]}
          align="end"
          title="provenance"
          detail="event #412 · deletable"
          delay={1500}
        />
      </svg>
      <figcaption className="mt-4 flex items-baseline justify-between gap-4 border-t border-ink/30 pt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-mute">
        <span className="whitespace-nowrap">Fig. 1 — a model of you</span>
        <span className="text-right normal-case tracking-normal">
          drawn from your own history · kept on your machine
        </span>
      </figcaption>
    </figure>
  );
}
