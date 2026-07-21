import { CopyCommand } from "./_components/CopyCommand";
import { Nav } from "./_components/Nav";
import { EngravedSelf } from "./_components/EngravedSelf";
import { SetupTabs } from "./_components/SetupTabs";
import { RepetitionFeed } from "./_components/RepetitionFeed";
import { ProCard } from "./_components/ProCard";
import { GithubIcon, NpmIcon, Glyph, TOOLS } from "@/components/ui/logos";
import { ArrowUpRight, Check, Cpu, Minus, X } from "lucide-react";

const EXT = { target: "_blank", rel: "noopener noreferrer" } as const;

const GITHUB = "https://github.com/persnally/persnally";
const NPM = "https://www.npmjs.com/package/persnally";

export default function Home() {
  return (
    <div className="relative min-h-screen overflow-x-clip">
      <Nav />
      <main>
        <Hero />
        <Marquee />
        <Wedge />
        <HowItWorks />
        <AskProof />
        <Engine />
        <Compare />
        <Trust />
        <Positioning />
        <Pricing />
        <GetStarted />
      </main>
      <Footer />
    </div>
  );
}

/* ── Shared bits ─────────────────────────────────────────────── */

/* numbered catalog eyebrow — the museum-plate section marker */
function Eyebrow({ n, children }: { n?: string; children: React.ReactNode }) {
  return (
    <span className="font-mono text-[11px] uppercase tracking-[0.22em] text-mute">
      {n && <span className="text-electric">№ {n}</span>}
      {n && " — "}
      {children}
    </span>
  );
}

function Section({
  id,
  children,
  className = "",
}: {
  id?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={`mx-auto w-full max-w-6xl px-6 ${className}`}>
      {children}
    </section>
  );
}

/* section opener: strong ink rule + eyebrow + display heading */
function SectionHead({
  n,
  eyebrow,
  title,
  lede,
  center = false,
}: {
  n?: string;
  eyebrow: string;
  title: React.ReactNode;
  lede?: React.ReactNode;
  center?: boolean;
}) {
  return (
    <div className={center ? "text-center" : ""}>
      <Eyebrow n={n}>{eyebrow}</Eyebrow>
      <h2
        className={`font-display mt-6 text-balance text-4xl leading-[1.02] sm:text-6xl ${center ? "mx-auto max-w-3xl" : "max-w-3xl"}`}
      >
        {title}
      </h2>
      {lede && (
        <p className={`mt-6 max-w-2xl text-lg leading-relaxed text-mute ${center ? "mx-auto" : ""}`}>
          {lede}
        </p>
      )}
    </div>
  );
}

/* the one emphasis move: italic serif in ink-blue */
function Em({ children }: { children: React.ReactNode }) {
  return <em className="font-display italic text-electric">{children}</em>;
}

/* ── Hero ────────────────────────────────────────────────────── */

function Hero() {
  return (
    <Section className="pb-20 pt-14 sm:pt-20">
      <div className="grid items-center gap-12 lg:grid-cols-[0.72fr_1.28fr] lg:gap-14">
        <div>
          <div className="rise" style={{ animationDelay: "0ms" }}>
            <Eyebrow>Open source · local-first · MCP</Eyebrow>
          </div>

          <h1
            className="font-display rise mt-6 text-balance text-[3.4rem] leading-[0.98] sm:text-7xl lg:text-[5.4rem]"
            style={{ animationDelay: "80ms" }}
          >
            Finally, every AI knows <Em>you.</Em>
          </h1>

          <p
            className="rise mt-7 max-w-xl text-pretty text-lg leading-relaxed text-mute"
            style={{ animationDelay: "160ms" }}
          >
            Persnally learns who you are from your AI history — your chats, your code, your
            decisions — and serves it to every AI you use. On your machine. Yours.
          </p>

          <div className="rise mt-9 flex max-w-xl flex-col gap-4" style={{ animationDelay: "240ms" }}>
            <CopyCommand command="npm i -g persnally && persnally setup" className="w-full" />
            <a
              href={GITHUB}
              {...EXT}
              className="group flex w-fit items-center gap-1.5 font-mono text-[12px] text-mute transition-colors hover:text-ink"
            >
              <GithubIcon className="size-3.5" />
              Star on GitHub
              <ArrowUpRight className="size-3" />
            </a>
          </div>
        </div>

        <div className="rise" style={{ animationDelay: "300ms" }}>
          <EngravedSelf />
        </div>
      </div>
    </Section>
  );
}

/* ── Marquee: newspaper ticker between hairlines ─────────────── */

function Marquee() {
  const row = [...TOOLS, ...TOOLS];
  return (
    <Section className="py-10">
      <div className="border-y border-ink/25 py-4">
        <div className="marquee">
          {[0, 1].map((dup) => (
            <div className="marquee-track" key={dup} aria-hidden={dup === 1}>
              {row.map((t, i) => (
                <span
                  key={`${dup}-${i}`}
                  className="flex items-center gap-2.5 whitespace-nowrap font-mono text-[13px] uppercase tracking-[0.14em] text-mute"
                >
                  <Glyph icon={t.icon} className="size-4" />
                  {t.name}
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
      <p className="mt-3 text-center font-mono text-[10px] uppercase tracking-[0.18em] text-faint">
        Works with the AI tools you already use
      </p>
    </Section>
  );
}

/* ── № 01 · The problem ──────────────────────────────────────── */

function Wedge() {
  return (
    <Section className="py-24">
      <SectionHead
        n="01"
        eyebrow="The problem"
        title={
          <>
            You explain yourself. Again. <span className="text-mute">And again.</span>
          </>
        }
      />
      <div className="mt-12 grid items-start gap-12 lg:grid-cols-2 lg:gap-16">
        <div>
          <p className="text-lg leading-relaxed text-mute">
            ChatGPT doesn&apos;t know what you told Claude. Your coding agent relearns your stack
            every session. Each tool meets you as a stranger — and the vendors can&apos;t fix it,
            because their business is keeping you inside their walls.
          </p>
          <figure className="mt-10">
            <div className="grid grid-cols-3 items-start gap-4 bg-paper">
              {[
                { src: "/art/head-front.webp", tool: "what Claude knows" },
                { src: "/art/head-top.webp", tool: "what ChatGPT knows" },
                { src: "/art/head-profile.webp", tool: "what Cursor knows" },
              ].map((h) => (
                <div key={h.src} className="text-center">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={h.src} alt="" aria-hidden width={480} height={480} className="mx-auto w-full max-w-[150px] mix-blend-multiply" />
                  <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.1em] text-mute">{h.tool}</p>
                </div>
              ))}
            </div>
            <figcaption className="mt-4 border-t border-ink/30 pt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-mute">
              Fig. 2 — three tools, three partial strangers. The same you.
            </figcaption>
          </figure>
        </div>
        <RepetitionFeed />
      </div>
    </Section>
  );
}

/* ── № 02 · How it works ─────────────────────────────────────── */

/* an engraved vignette with its meaning spelled out underneath */
function Vignette({
  src,
  cap,
  h = "h-44",
  natural = false,
}: {
  src: string;
  cap: string;
  h?: string;
  /* true for near-square/circular plates (medallions) — shown at their own
     aspect, centered and modestly sized, instead of stretched to card width
     (which is right for wide scenes but crops or letterboxes a roundel). */
  natural?: boolean;
}) {
  return (
    <figure className={`mt-5 ${natural ? "flex flex-col items-center" : ""}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt=""
        aria-hidden
        width={640}
        height={540}
        className={natural ? "w-full max-w-[260px] mix-blend-multiply" : `w-full ${h} object-contain mix-blend-multiply`}
      />
      <figcaption className="mt-2 text-center font-mono text-[10px] uppercase tracking-[0.12em] text-faint">
        {cap}
      </figcaption>
    </figure>
  );
}

function HowItWorks() {
  const steps = [
    {
      k: "I",
      label: "Import",
      t: "Import your history",
      d: "One command finds your Claude & ChatGPT exports, your Claude Code sessions, and your git repos, and reads them.",
      art: <Vignette src="/art/press.webp" cap="the press — your history, taken in" h="h-[265px]" />,
      visual: <ImportViz />,
    },
    {
      k: "II",
      label: "Learn · local",
      t: "It learns, on your machine",
      d: "A local daemon turns that history into an evidence-linked model of you — never our cloud.",
      art: <Vignette src="/art/compositors.webp" cap="the compositors — studied, locally" h="h-[265px]" />,
      visual: <LearnViz />,
    },
    {
      k: "III",
      label: "Serve · MCP",
      t: "Every AI reads it",
      d: "Over MCP — the protocol your tools already speak — Claude, Cursor, and your agents read it the moment a session starts.",
      art: <Vignette src="/art/mercury.webp" cap="the messenger — served to every tool" h="h-[265px]" />,
      visual: <ServeViz />,
    },
  ];
  return (
    <Section id="how" className="py-24">
      <SectionHead n="02" eyebrow="How it works" title="Your context, in every tool you touch." />

      <div className="mt-12 grid gap-5 lg:grid-cols-3">
        {steps.map((s) => (
          <div key={s.k} className="plate flex flex-col p-6">
            <div className="flex items-baseline justify-between border-b border-ink/20 pb-4">
              <span className="font-display text-3xl text-ink">{s.k}.</span>
              <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-mute">{s.label}</span>
            </div>
            <h3 className="font-display mt-5 text-2xl text-ink">{s.t}</h3>
            <p className="mt-2.5 text-[15px] leading-relaxed text-mute">{s.d}</p>
            {s.art}
            <div className="mt-auto pt-6">{s.visual}</div>
          </div>
        ))}
      </div>
    </Section>
  );
}

const claudeIcon = TOOLS.find((t) => t.name === "Claude")!.icon;

function Terminal({ children }: { children: React.ReactNode }) {
  return <div className="terminal rounded-[2px] p-3.5">{children}</div>;
}

function ImportViz() {
  const sources = ["Claude & ChatGPT exports", "Claude Code sessions", "git repos"];
  return (
    <Terminal>
      <p className="font-mono text-[12px]">
        <span className="text-electric-glow">$</span> persnally import
      </p>
      <ul className="mt-2.5 space-y-1.5 font-mono text-[11px] opacity-75">
        {sources.map((src) => (
          <li key={src} className="flex items-center gap-2">
            <Check className="size-3 shrink-0" />
            {src}
          </li>
        ))}
      </ul>
    </Terminal>
  );
}

function LearnViz() {
  const signals = ["ships the smallest design", "prefers SQLite", "guards user trust"];
  return (
    <Terminal>
      <p className="font-mono text-[11px] opacity-60">building your model…</p>
      <ul className="mt-2.5 space-y-1.5 font-mono text-[12px]">
        {signals.map((sig) => (
          <li key={sig} className="flex items-center gap-2">
            <span className="size-1 shrink-0 rounded-full bg-current" />
            {sig}
          </li>
        ))}
      </ul>
      <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.14em] opacity-60">
        <Cpu className="mr-1.5 inline size-3" />
        on your machine
      </p>
    </Terminal>
  );
}

function ServeViz() {
  return (
    <Terminal>
      <p className="flex items-center gap-2 font-mono text-[12px]">
        <Glyph icon={claudeIcon} className="size-3.5" />
        Claude · session started
      </p>
      <div className="mt-3 border-l-2 border-paper/30 pl-3">
        <p className="font-mono text-[11px]">↳ loaded your context</p>
        <p className="mt-1 flex items-center gap-1.5 font-mono text-[10px] opacity-60">
          persnally_context <Check className="size-3" /> 2ms
        </p>
      </div>
    </Terminal>
  );
}

/* ── № 03 · Ask ──────────────────────────────────────────────── */

/* the correction, written in your own hand — a 1657 author's quill with the
   rubber stamp that makes it law pressed over the plate */
function CorrectionLedger() {
  return (
    <figure className="relative mt-5">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/art/author.webp"
        alt=""
        aria-hidden
        width={640}
        height={435}
        className="w-full mix-blend-multiply"
      />
      <span
        aria-hidden
        className="absolute bottom-12 right-4 rotate-[-8deg] border-2 border-electric bg-paper/60 px-3 py-2 font-mono text-[12px] font-bold uppercase tracking-[0.18em] text-electric"
        style={{ boxShadow: "inset 0 0 0 2px var(--color-paper), inset 0 0 0 3.5px var(--color-electric)" }}
      >
        Authoritative
      </span>
      <figcaption className="mt-2 text-center font-mono text-[10px] uppercase tracking-[0.12em] text-faint">
        written in your own hand — outranks everything inferred
      </figcaption>
    </figure>
  );
}

function AskProof() {
  return (
    <Section id="ask" className="py-24">
      <SectionHead
        n="03"
        eyebrow="Answers, not just recall"
        title={
          <>
            The only context engine your AI can <Em>ask.</Em>
          </>
        }
        lede={
          <>
            Other tools store facts. Persnally answers <em>what you&apos;d do</em> — with a
            confidence score, deferring to you when the evidence is thin.
          </>
        }
      />

      <div className="mt-12 grid gap-5 md:grid-cols-2">
        <div className="plate flex flex-col p-6">
          <h3 className="font-display text-2xl text-ink">It answers, or it defers</h3>
          <p className="mt-2.5 text-[15px] leading-relaxed text-mute">
            Your agent asks Persnally instead of interrupting you. Below its confidence bar, it
            sends the agent back to you — never a made-up answer.
          </p>
          <Vignette src="/art/justice.webp" cap="the evidence, weighed — below the bar, it defers to you" natural />
          <div className="mt-auto">
            <Terminal>
              <p className="font-mono text-[12px] opacity-75">
                persnally_ask <span className="opacity-60">&ldquo;tests before I merge?&rdquo;</span>
              </p>
              <p className="mt-2 font-mono text-[12px]">
                ↳ yes — you demand proof before merge; add e2e on the changed paths.
              </p>
              <p className="mt-1.5 font-mono text-[11px] opacity-60">confidence 0.92 · 3 evidence events</p>
            </Terminal>
          </div>
        </div>
        <div className="plate flex flex-col p-6">
          <h3 className="font-display text-2xl text-ink">Correct it once, it sticks</h3>
          <p className="mt-2.5 text-[15px] leading-relaxed text-mute">
            Tell it it&apos;s wrong and the correction becomes authoritative — it outranks everything
            inferred, and the wrong answer never comes back.
          </p>
          <CorrectionLedger />
          <div className="mt-auto">
            <Terminal>
              <p className="font-mono text-[12px] opacity-75">
                persnally correct <span className="opacity-60">&ldquo;I use pnpm, not npm&rdquo;</span>
              </p>
              <p className="mt-2 font-mono text-[12px]">↳ recorded — authoritative.</p>
              <p className="mt-1.5 font-mono text-[11px] opacity-60">every future answer respects it</p>
            </Terminal>
          </div>
        </div>
      </div>

      {/* the proof: real output, generic AI vs an AI that read your Persnally */}
      <div className="plate mt-8">
        <div className="border-b border-ink/20 px-6 py-4">
          <Eyebrow>See the difference</Eyebrow>
          <p className="mt-2 text-[15px] text-mute">
            Same prompt — <span className="text-ink">&ldquo;write a Slack message telling my team the deploy went out&rdquo;</span> —
            asked of a blank AI and an AI that read your Persnally:
          </p>
        </div>
        <div className="grid md:grid-cols-2">
          <div className="border-b border-ink/20 p-6 md:border-b-0 md:border-r">
            <p className="mb-3 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-faint">
              <X className="size-3.5" strokeWidth={2} /> Generic AI
            </p>
            <p className="text-[15px] leading-relaxed text-mute">
              🚀 <b className="text-mute">Deploy is live!</b> Just pushed the latest changes to
              production. Everything looks good so far — let me know if you spot anything unexpected.
            </p>
          </div>
          <div className="p-6">
            <p className="mb-3 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-electric">
              <Check className="size-3.5" strokeWidth={2.25} /> AI + Persnally
            </p>
            <p className="font-mono text-[13.5px] leading-relaxed text-ink">
              deploy is out. watching sentry/logs for the next hour, will confirm clean or flag
              issues here.
            </p>
          </div>
        </div>
      </div>
      <p className="mt-4 text-center text-[14px] italic text-faint">
        Terse, lowercase, no emoji, and it knew to watch Sentry — because that&apos;s how you actually
        work. Not configured; learned.
      </p>
    </Section>
  );
}

/* ── № 04 · Under the hood ───────────────────────────────────── */

function Engine() {
  return (
    <Section className="py-24">
      <SectionHead
        n="04"
        eyebrow="Under the hood"
        title="More than memory. An engine."
        lede="Structured events, derived views, a walkable provenance graph — decay-aware, and entirely your own."
      />

      <div className="mt-12 grid gap-5 lg:grid-cols-2">
        <div className="plate p-6">
          <Eyebrow>Cross-vendor · MCP</Eyebrow>
          <h3 className="font-display mt-4 text-2xl text-ink">One context, every tool reads it.</h3>
          <Vignette src="/art/fountain.webp" cap="the well — one source, every tool draws" h="h-[205px]" />
          <div className="mt-5 space-y-0 border-t border-ink/20">
            {[
              { icon: <Glyph icon={claudeIcon} className="size-4" />, name: "Claude", method: "persnally_context" },
              { icon: <Glyph icon={TOOLS.find((t) => t.name === "Cursor")!.icon} className="size-4" />, name: "Cursor", method: "persnally_context" },
              { icon: <Glyph icon={claudeIcon} className="size-4" />, name: "Claude Code", method: "persnally_ask" },
              { icon: <Cpu className="size-4 text-electric" />, name: "your agent", method: "persnally_search" },
            ].map((r) => (
              <div key={r.name + r.method} className="flex items-center justify-between border-b border-ink/15 py-2.5">
                <span className="flex items-center gap-2.5 text-[15px] text-ink">
                  {r.icon}
                  {r.name}
                </span>
                <span className="flex items-center gap-2 font-mono text-[11px] text-mute">
                  {r.method}
                  <Check className="size-3.5 text-electric" />
                </span>
              </div>
            ))}
          </div>
          <p className="mt-4 font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
            speaks MCP — adopted by every major AI
          </p>
        </div>

        <div className="plate p-6">
          <Eyebrow>Provenance</Eyebrow>
          <h3 className="font-display mt-4 text-2xl text-ink">Every claim cites its evidence.</h3>
          <Vignette
            src="/art/specimen.webp"
            cap="the specimen — every part numbered, keyed to its source"
            natural
          />
          <div className="mt-5 border border-ink/25 p-4">
            <p className="text-[15px] text-ink">Guards user trust as non-negotiable.</p>
            <p className="mt-2 font-mono text-[11px] text-electric">
              ↳ why does it think this? <span className="ml-1 text-faint">3 events</span>
            </p>
          </div>
          {/* the claim hangs from its evidence — the hero's leader-line language */}
          <ul className="ml-6 border-l-2 border-electric/50 font-mono text-[12px] text-mute">
            {[
              ["#128", "imported 142 Claude conversations"],
              ["#412", "vetoed telemetry without consent"],
              ["#087", "chose local-first storage"],
            ].map(([id, t]) => (
              <li key={id} className="relative py-2 pl-5">
                <span aria-hidden className="absolute left-0 top-1/2 h-px w-3.5 bg-electric/50" />
                <span className="text-electric">{id}</span> · {t}
              </li>
            ))}
          </ul>
          <p className="ml-6 pt-1 font-mono text-[10px] uppercase tracking-[0.12em] text-faint">
            3 events · 0 guesses · each one deletable
          </p>
        </div>

        <div className="plate p-6 lg:col-span-2">
          <Eyebrow>Per-client scopes</Eyebrow>
          <h3 className="font-display mt-4 text-2xl text-ink">Decide exactly what each AI can see.</h3>
          <div className="mt-5 grid items-center gap-8 lg:grid-cols-[0.9fr_1.1fr]">
            <Vignette src="/art/cards.webp" cap="the card table — each player sees only its own hand" h="h-[242px]" />
            <div className="grid gap-x-8 gap-y-0 sm:grid-cols-1">
            {[
              { name: "Claude", icon: <Glyph icon={claudeIcon} className="size-4" />, state: "allowed" },
              { name: "Cursor", icon: <Glyph icon={TOOLS.find((t) => t.name === "Cursor")!.icon} className="size-4" />, state: "allowed" },
              { name: "Claude Code", icon: <Glyph icon={claudeIcon} className="size-4" />, state: "scoped" },
              { name: "agents", icon: <Cpu className="size-4 text-electric" />, state: "scoped" },
            ].map((r) => (
              <div key={r.name} className="flex items-center justify-between border-b border-ink/15 py-2.5">
                <span className="flex items-center gap-2.5 text-[15px] text-ink">
                  {r.icon}
                  {r.name}
                </span>
                <span
                  className={`font-mono text-[11px] uppercase tracking-[0.12em] ${r.state === "allowed" ? "text-electric" : "text-mute"}`}
                >
                  {r.state}
                </span>
              </div>
            ))}
            </div>
          </div>
        </div>
      </div>
    </Section>
  );
}

/* ── № 05 · How it compares ──────────────────────────────────── */

function Compare() {
  // ✓ has · ~ partial · ✗ no — verified against each product's own docs/repos, July 2026.
  const cols = ["Persnally", "claude-mem", "Mem0 · Supermemory", "Unabyss · cloud vaults"];
  const rows: { cap: string; marks: ("y" | "p" | "n")[] }[] = [
    { cap: "Your AI can ask it — answer with a confidence score, defers when unsure", marks: ["y", "n", "n", "n"] },
    { cap: "Learns when you correct it — the correction outranks everything inferred", marks: ["y", "n", "p", "p"] },
    { cap: "Synthesizes a model of you — taste, voice, how you decide", marks: ["y", "n", "p", "p"] },
    { cap: "Local plaintext on your machine + source you can audit", marks: ["y", "y", "p", "n"] },
    { cap: "Reads your chat exports + git history", marks: ["y", "p", "p", "p"] },
  ];
  const Mark = ({ m }: { m: "y" | "p" | "n" }) =>
    m === "y" ? (
      <Check className="mx-auto size-4 text-electric" strokeWidth={2.5} />
    ) : m === "p" ? (
      <Minus className="mx-auto size-4 text-faint" strokeWidth={2} />
    ) : (
      <X className="mx-auto size-4 text-line" strokeWidth={2} />
    );

  return (
    <Section id="compare" className="py-24">
      <SectionHead
        n="05"
        eyebrow="How it compares"
        title={
          <>
            Everyone remembers. Persnally <Em>answers.</Em>
          </>
        }
        lede="No one else answers what you'd do, learns when you correct it, and lets you verify all of it on your own machine."
      />

      <div className="plate mt-12 overflow-x-auto">
        <table className="w-full min-w-[680px] border-collapse text-left">
          <thead>
            <tr className="border-b border-ink">
              <th className="p-4 font-mono text-[11px] font-normal uppercase tracking-[0.14em] text-faint">
                Capability
              </th>
              {cols.map((c, i) => (
                <th
                  key={c}
                  className={`p-4 text-center font-mono text-[11px] uppercase tracking-[0.1em] ${i === 0 ? "text-electric" : "text-mute"}`}
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.cap} className="border-b border-ink/15 last:border-0">
                <td className="p-4 text-[14.5px] leading-snug text-ink">{r.cap}</td>
                {r.marks.map((m, i) => (
                  <td key={i} className={`p-4 ${i === 0 ? "bg-electric/[0.05]" : ""}`}>
                    <Mark m={m} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mx-auto mt-6 max-w-3xl text-center text-[13.5px] leading-relaxed text-faint">
        <Check className="inline size-3 text-electric" /> has it ·{" "}
        <Minus className="inline size-3 text-faint" /> partial ·{" "}
        <X className="inline size-3 text-line" /> no. Verified against each product&apos;s own docs
        and repos, July 2026.
      </p>
    </Section>
  );
}

/* ── № 06 · Trust ────────────────────────────────────────────── */

function Trust() {
  const pillars = [
    {
      t: "Local-first",
      art: "/art/lock.webp",
      d: "Your context lives in ~/.persnally — not our cloud, not any vendor's silo.",
      viz: (
        <Terminal>
          <p className="font-mono text-[11px] opacity-60">~/.persnally</p>
          <ul className="mt-2 space-y-1 font-mono text-[12px]">
            <li>persnally.db</li>
            <li>config.json</li>
          </ul>
          <p className="mt-2.5 font-mono text-[10px] opacity-60">stays on your machine, never our cloud</p>
        </Terminal>
      ),
    },
    {
      t: "Truly deletable",
      art: "/art/bonfire.webp",
      d: "Forget a topic and everything derived from it is erased, then rebuilt.",
      viz: (
        <Terminal>
          <p className="font-mono text-[12px]">
            <span className="text-electric-glow">$</span> persnally forget &ldquo;rust&rdquo;
          </p>
          <ul className="mt-2 space-y-1 font-mono text-[11px] opacity-75">
            <li>✓ 18 events erased</li>
            <li>✓ derived views rebuilt</li>
          </ul>
          <p className="mt-2.5 font-mono text-[10px] opacity-60">no tombstones · no residue</p>
        </Terminal>
      ),
    },
    {
      t: "Provenance-complete",
      art: "/art/microscope.webp",
      d: "“Why does it think this?” is a real lookup, never a guess.",
      viz: (
        <Terminal>
          <p className="font-mono text-[11px]">↳ why &ldquo;guards user trust&rdquo;?</p>
          <ul className="mt-2 space-y-1 font-mono text-[11px] opacity-75">
            <li>#412 · vetoed telemetry</li>
            <li>#087 · chose local-first</li>
            <li>#203 · removed analytics</li>
          </ul>
          <p className="mt-2.5 font-mono text-[10px] opacity-60">3 events · 0 guesses</p>
        </Terminal>
      ),
    },
    {
      t: "Source-available",
      art: "/art/ecorche.webp",
      d: "Read the engine, audit the claims, run it yourself. The schema and MCP interface are an open spec.",
      viz: (
        <a href={GITHUB} {...EXT} className="group block">
          <Terminal>
            <p className="flex items-center gap-2 font-mono text-[12px]">
              <GithubIcon className="size-4" />
              persnally/persnally
              <ArrowUpRight className="ml-auto size-3.5 opacity-60 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
            </p>
            <p className="mt-2.5 font-mono text-[10px] opacity-60">FSL → MIT after 2y · open spec</p>
          </Terminal>
        </a>
      ),
    },
  ];
  return (
    <Section id="trust" className="py-24">
      <SectionHead
        n="06"
        eyebrow="Your data, your rules"
        title="A context engine you can actually trust."
        lede="Trust isn't a privacy policy here — it's the architecture. Not promises; properties you can check."
      />

      <div className="mt-12 grid gap-5 md:grid-cols-2">
        {pillars.map((p) => (
          <div key={p.t} className="plate flex flex-col overflow-hidden p-6">
            <h3 className="font-display text-2xl text-ink">{p.t}</h3>
            <p className="mt-2.5 text-[15px] leading-relaxed text-mute">{p.d}</p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={p.art} alt="" aria-hidden width={900} height={474} className="mt-5 w-full mix-blend-multiply" />
            <div className="mt-auto pt-5">{p.viz}</div>
          </div>
        ))}
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-center gap-x-8 gap-y-3 border-y border-ink/25 px-4 py-5">
        {["No account", "Bring your own keys", "Works offline", "Open spec"].map((c) => (
          <span key={c} className="inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.12em] text-mute">
            <Check className="size-3 text-electric" />
            {c}
          </span>
        ))}
      </div>
    </Section>
  );
}

/* ── № 07 · The difference ───────────────────────────────────── */

function Positioning() {
  const them = [
    "A database of you — you save, you search, you retrieve",
    "Recalls facts; can't answer what you'd decide",
    "Correct it? Delete a memory, at best",
    "A black box — it can't tell you why",
  ];
  const us = [
    "A model of you your AI can ask — with a confidence score",
    "Answers what you'd do; defers to you when unsure",
    "Correct it once and it sticks — outranks everything inferred",
    "Every claim cites its evidence — local, auditable, deletable",
  ];
  return (
    <Section className="py-24">
      <SectionHead n="07" eyebrow="The difference" title={<></>} center />
      <figure className="mx-auto -mt-2 w-fit text-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/art/geometric-head.webp"
          alt="Engraving of a head divided into measured, lettered sections"
          width={240}
          height={240}
          className="mx-auto w-[210px] mix-blend-multiply"
        />
        <figcaption className="mt-1 font-mono text-[10px] uppercase tracking-[0.14em] text-mute">
          Fig. 6 — the model of you, measured. Held by its subject.
        </figcaption>
      </figure>
      <p className="font-display mx-auto mt-8 max-w-3xl text-balance text-center text-4xl leading-[1.05] sm:text-6xl">
        Every AI knows <span className="text-mute">you.</span> And it&apos;s <Em>yours.</Em>
      </p>

      <div className="mx-auto mt-14 grid max-w-3xl gap-5 md:grid-cols-2">
        <div className="plate p-7">
          <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-faint">
            Every other memory tool
          </p>
          <p className="mt-1.5 text-sm italic text-faint">&ldquo;a place to store facts about you&rdquo;</p>
          <ul className="mt-6 space-y-3.5">
            {them.map((x) => (
              <li key={x} className="flex items-start gap-3 text-[15px] text-mute">
                <X className="mt-0.5 size-4 shrink-0 text-faint" strokeWidth={2} />
                {x}
              </li>
            ))}
          </ul>
        </div>

        <div className="plate border-electric p-7">
          <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-electric">Persnally</p>
          <p className="mt-1.5 text-sm italic text-mute">your own context engine</p>
          <ul className="mt-6 space-y-3.5">
            {us.map((x) => (
              <li key={x} className="flex items-start gap-3 text-[15px] text-ink">
                <Check className="mt-0.5 size-4 shrink-0 text-electric" strokeWidth={2.25} />
                {x}
              </li>
            ))}
          </ul>
        </div>
      </div>

    </Section>
  );
}

/* ── № 08 · Pricing ──────────────────────────────────────────── */

function Pricing() {
  const free = [
    "The full engine — import, learn, synthesize your profile",
    "Serve your context to every AI over MCP",
    "The dashboard: inspect, audit provenance, delete",
    "Bring your own key, or run fully local with Ollama",
  ];
  // The page's one full-bleed color moment: pricing on the electric field.
  return (
    <section id="pricing" className="bg-electric py-24 text-paper">
      <div className="mx-auto w-full max-w-6xl px-6">
        <div className="text-center">
          <span className="font-mono text-[11px] uppercase tracking-[0.22em] text-paper/70">
            <span className="text-paper">№ 08</span> — Pricing
          </span>
          <h2 className="font-display mx-auto mt-6 max-w-3xl text-balance text-4xl leading-[1.02] sm:text-6xl">
            The engine is free. <em className="italic">Forever.</em>
          </h2>
          <p className="mt-5 font-mono text-[12px] uppercase tracking-[0.22em] text-paper/70">
            Free · Pro · Teams later
          </p>
          <p className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-paper/80">
            Everything that touches your data runs on your machine, free. Pro adds cloud
            conveniences — carrying ciphertext only, never your plaintext.
          </p>
        </div>

        <div className="mx-auto mt-12 grid max-w-3xl gap-5 md:grid-cols-2">
          <div className="plate flex flex-col p-7">
            <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-faint">Free</p>
            <p className="font-display mt-3 text-4xl text-ink">
              $0 <span className="text-lg text-faint">forever</span>
            </p>
            <figure className="mt-5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/art/loom.webp" alt="" aria-hidden width={900} height={360} className="w-full mix-blend-multiply" />
              <figcaption className="mt-2 text-center font-mono text-[10px] uppercase tracking-[0.12em] text-faint">
                the loom — the whole engine, at home
              </figcaption>
            </figure>
            <ul className="mt-6 space-y-3.5">
              {free.map((x) => (
                <li key={x} className="flex items-start gap-3 text-[15px] text-mute">
                  <Check className="mt-0.5 size-4 shrink-0 text-electric" strokeWidth={2} />
                  {x}
                </li>
              ))}
            </ul>
            <div className="mt-auto pt-7">
              <a
                href="#start"
                className="block border border-ink px-4 py-2.5 text-center font-mono text-[12px] uppercase tracking-[0.14em] text-ink transition-colors hover:bg-ink hover:text-paper"
              >
                Install now
              </a>
            </div>
          </div>

          <ProCard />
        </div>

        <p className="mx-auto mt-10 max-w-xl text-center text-[15px] italic leading-relaxed text-paper/75">
          Privacy is never the paid tier. The local engine, the dashboard, and deletion stay free —
          Pro is convenience on top, not a wall around your own data.
        </p>
      </div>
    </section>
  );
}

/* ── № 09 · Get started ──────────────────────────────────────── */

function GetStarted() {
  return (
    <Section id="start" className="py-24">
      <SectionHead
        n="09"
        eyebrow="Five minutes to your mirror"
        title="Install, and see yourself."
        lede="One command finds your exports, reads your repos, synthesizes a profile, connects your AI clients, and opens the dashboard."
        center
      />

      <div className="mx-auto mt-10 max-w-2xl">
        <SetupTabs />
        <p className="mt-5 text-center font-mono text-[11px] leading-relaxed text-faint">
          macOS · Linux · Windows · Node 20+ · background autostart on macOS &amp; Linux · bring your
          own key, or run fully local with Ollama
        </p>
      </div>
    </Section>
  );
}

/* ── Footer ──────────────────────────────────────────────────── */

function Footer() {
  return (
    <footer className="relative overflow-hidden border-t border-ink/20">
      <Section className="flex flex-col items-start justify-between gap-8 pt-14 sm:flex-row sm:items-center">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-faint">© 2026 Persnally</p>
          <p className="font-display mt-2.5 text-2xl tracking-tight text-ink">
            So every AI finally knows <Em>you.</Em>
          </p>
        </div>
        <div className="flex flex-col items-start gap-4 sm:items-end">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3 font-mono text-[12px] uppercase tracking-[0.12em] text-mute">
            <a
              href={GITHUB}
              {...EXT}
              aria-label="Persnally on GitHub"
              title="GitHub"
              className="transition-colors hover:text-ink"
            >
              <GithubIcon className="size-[18px]" />
            </a>
            <a
              href={NPM}
              {...EXT}
              aria-label="persnally on npm"
              title="npm"
              className="transition-colors hover:text-ink"
            >
              <NpmIcon className="size-[18px]" />
            </a>
            <a href={`${GITHUB}/blob/main/LICENSE`} {...EXT} className="transition-colors hover:text-ink">
              FSL-1.1-MIT
            </a>
          </div>
          <a
            href="https://www.producthunt.com/products/persnally?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-persnally"
            {...EXT}
            aria-label="Persnally on Product Hunt"
            className="transition-opacity hover:opacity-85"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1182562&theme=light&t=1782584790813"
              alt="Persnally - So every AI finally knows you | Product Hunt"
              width={220}
              height={48}
            />
          </a>
        </div>
      </Section>

      <Section className="pt-8">
        <p className="font-mono text-[10px] leading-relaxed text-faint">
          Engravings: “Chart of Mental Geometry” (Frederick Bridges, c. 1860) and period plates —{" "}
          <a
            href="https://wellcomecollection.org/works"
            {...EXT}
            className="underline decoration-ink/30 underline-offset-2 transition-colors hover:text-ink"
          >
            Wellcome Collection
          </a>
          , CC BY 4.0.
        </p>
      </Section>

      {/* Giant engraved wordmark — outlined serif, like the plate lettering */}
      <div aria-hidden className="pointer-events-none mt-10 select-none px-6">
        <span
          className="font-display block translate-y-[14%] text-center text-[clamp(4rem,20vw,16rem)] leading-[0.8] tracking-tight text-transparent"
          style={{ WebkitTextStroke: "1.5px color-mix(in oklab, var(--color-ink) 38%, transparent)" }}
        >
          persnally
          <span style={{ WebkitTextStroke: "1.5px var(--color-electric)" }}>.</span>
        </span>
      </div>
    </footer>
  );
}
