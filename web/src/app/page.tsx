import Link from "next/link";
import { CopyCommand } from "./_components/CopyCommand";
import { HeroHub } from "./_components/HeroHub";
import { AnimatedGridPattern } from "@/components/magicui/animated-grid-pattern";
import { SetupTabs } from "./_components/SetupTabs";
import { SpotlightCard } from "./_components/SpotlightCard";
import { Features } from "@/components/ui/features-10";
import { GithubIcon, NpmIcon, Glyph, TOOLS } from "@/components/ui/logos";
import { RepetitionFeed } from "./_components/RepetitionFeed";
import { ProCard } from "./_components/ProCard";
import { ArrowUpRight, Check, ChevronRight, Cpu, Database, Download, FileJson, Minus, Plug, Star, X } from "lucide-react";

const EXT = { target: "_blank", rel: "noopener noreferrer" } as const;
const arrowCls =
  "size-3.5 shrink-0 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5";

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
        <Features />
        <HowItWorks />
        <AskProof />
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

function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`font-semibold tracking-tight text-ink ${className}`}>
      persnally<span className="text-electric">.</span>
    </span>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-electric">{children}</span>
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

/* ── Nav ─────────────────────────────────────────────────────── */

function Nav() {
  return (
    <header className="sticky top-0 z-50 border-b border-line/60 bg-night/70 backdrop-blur-xl">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-6">
        <Link href="/" aria-label="Persnally home" className="transition-opacity hover:opacity-80">
          <Wordmark className="text-[17px]" />
        </Link>
        <nav className="hidden items-center gap-8 text-sm text-mute md:flex">
          <a href="#how" className="transition-colors hover:text-ink">
            How it works
          </a>
          <a href="#ask" className="transition-colors hover:text-ink">
            Ask it
          </a>
          <a href="#trust" className="transition-colors hover:text-ink">
            Your data
          </a>
          <a href="#pricing" className="transition-colors hover:text-ink">
            Pricing
          </a>
          <a
            href={GITHUB}
            {...EXT}
            className="group flex items-center gap-1.5 transition-colors hover:text-ink"
          >
            <GithubIcon className="size-4" />
            GitHub
            <ArrowUpRight className={arrowCls} />
          </a>
        </nav>
        <a
          href="#start"
          className="rounded-lg bg-electric px-4 py-2 text-sm font-medium text-white shadow-[0_0_28px_-6px_var(--color-electric)] transition-colors hover:bg-electric-deep"
        >
          Get started
        </a>
      </div>
    </header>
  );
}

/* ── Hero ────────────────────────────────────────────────────── */

function Hero() {
  return (
    <Section className="relative pt-24 pb-24 sm:pt-32">
      <div className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[820px] overflow-hidden">
        <div className="aurora" />
        <AnimatedGridPattern
          numSquares={34}
          maxOpacity={0.15}
          duration={4}
          className="[mask-image:radial-gradient(640px_circle_at_50%_170px,white,transparent)] text-electric/35 stroke-electric/10"
        />
      </div>

      <div className="mx-auto max-w-4xl text-center">
        <div className="rise" style={{ animationDelay: "0ms" }}>
          <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface/60 px-3 py-1 font-mono text-[11px] text-mute backdrop-blur">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-electric" />
            Your own context engine
          </span>
        </div>

        <h1
          className="rise mt-7 text-balance text-[2.6rem] font-semibold leading-[1.05] tracking-tight sm:text-6xl lg:text-7xl"
          style={{ animationDelay: "80ms" }}
        >
          Finally, every AI
          <br className="hidden sm:block" /> knows <span className="text-gradient">you</span>.
        </h1>

        <p
          className="rise mx-auto mt-6 max-w-2xl text-pretty text-base leading-relaxed text-mute"
          style={{ animationDelay: "160ms" }}
        >
          Persnally learns who you are from your AI history — your chats, your code, your decisions —
          so every tool you use stops treating you like a stranger. Your AIs read it, and can even
          ask it what you&apos;d do. It lives on your machine, and it&apos;s yours.
        </p>

        <div
          className="rise mx-auto mt-9 flex max-w-md flex-col items-center gap-4"
          style={{ animationDelay: "240ms" }}
        >
          <CopyCommand command="npm i -g persnally && persnally setup" className="w-full shimmer" />
          <div className="flex items-center gap-4 text-xs text-mute">
            <a
              href={GITHUB}
              {...EXT}
              className="group flex items-center gap-1.5 transition-colors hover:text-ink"
            >
              <GithubIcon className="size-3.5" />
              Star on GitHub
              <ArrowUpRight className="size-3 shrink-0 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
            </a>
            <span className="text-line">·</span>
            <a
              href={NPM}
              {...EXT}
              className="group flex items-center gap-1.5 transition-colors hover:text-ink"
            >
              <NpmIcon className="size-3.5" />
              View on npm
              <ArrowUpRight className="size-3 shrink-0 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
            </a>
          </div>
          <a
            href="https://www.producthunt.com/products/persnally?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-persnally"
            {...EXT}
            aria-label="Persnally on Product Hunt"
            className="mt-1 inline-block transition-opacity hover:opacity-90"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1182562&theme=light&t=1782584790813"
              alt="Persnally - So every AI finally knows you | Product Hunt"
              width={250}
              height={54}
            />
          </a>
        </div>
      </div>

      <div className="rise mt-16 sm:mt-20" style={{ animationDelay: "340ms" }}>
        <HeroHub />
      </div>
    </Section>
  );
}

/* ── Marquee: works with the tools you already use ───────────── */

function Marquee() {
  const row = [...TOOLS, ...TOOLS];
  return (
    <Section className="py-10">
      <p className="mb-7 text-center font-mono text-[11px] uppercase tracking-[0.18em] text-faint">
        Works with the AI tools you already use
      </p>
      <div className="marquee">
        {[0, 1].map((dup) => (
          <div className="marquee-track" key={dup} aria-hidden={dup === 1}>
            {row.map((t, i) => (
              <span
                key={`${dup}-${i}`}
                className="flex items-center gap-2.5 whitespace-nowrap text-lg font-medium text-mute"
              >
                <Glyph icon={t.icon} className="size-5" />
                {t.name}
              </span>
            ))}
          </div>
        ))}
      </div>
    </Section>
  );
}

/* ── Wedge ───────────────────────────────────────────────────── */

function Wedge() {
  return (
    <Section className="py-28">
      <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
        <div>
          <Eyebrow>The problem</Eyebrow>
          <h2 className="mt-5 text-3xl font-semibold leading-tight tracking-tight sm:text-5xl">
            You explain yourself.
            <br className="hidden sm:block" /> Again. And again.
          </h2>
          <p className="mt-6 text-lg leading-relaxed text-mute">
            ChatGPT doesn&apos;t know what you told Claude. Your coding agent relearns your stack
            every session, or stops to ask. So you paste the same context — your tools, your
            conventions, your taste — into tool after tool.
          </p>
          <p className="mt-4 text-[15px] leading-relaxed text-faint">
            Each meets you as a stranger. And the model vendors can&apos;t fix it — their business
            is keeping you inside their walls, not sharing you across them.
          </p>
        </div>
        <RepetitionFeed />
      </div>
    </Section>
  );
}

/* ── How it works — animated beam pipeline ───────────────────── */

function HowItWorks() {
  const steps = [
    {
      k: "01",
      label: "Import",
      Icon: Download,
      t: "Import your history",
      d: "One command finds your Claude & ChatGPT exports, your Claude Code sessions, and your git repos, and reads them.",
      visual: <ImportViz />,
    },
    {
      k: "02",
      label: "Learn · local",
      Icon: Cpu,
      t: "It learns, on your machine",
      d: "A local daemon turns that activity into a structured, evidence-linked model of who you are — kept on your machine, never our cloud.",
      visual: <LearnViz />,
    },
    {
      k: "03",
      label: "Serve · MCP",
      Icon: Plug,
      t: "Every AI reads it",
      d: "Connected over MCP — the open protocol your AI tools already speak — Claude, Cursor, and your agents read your context the moment a session starts.",
      visual: <ServeViz />,
    },
  ];
  return (
    <Section id="how" className="py-28">
      <div className="max-w-2xl">
        <Eyebrow>How it works</Eyebrow>
        <h2 className="mt-5 text-3xl font-semibold leading-tight tracking-tight sm:text-5xl">
          Your context, in every tool you touch.
        </h2>
      </div>

      <div className="mt-14 flex flex-col gap-4 lg:flex-row lg:items-stretch lg:gap-3">
        {steps.flatMap((s, i) => {
          const card = (
            <div key={s.k} className="flex flex-1 flex-col rounded-2xl border border-line bg-surface p-6">
              <div className="flex items-center gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-electric/30 bg-electric/10 text-electric shadow-[0_0_28px_-8px_var(--color-electric)]">
                  <s.Icon className="size-5" strokeWidth={1.75} />
                </span>
                <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-faint">
                  Step {s.k} · {s.label}
                </span>
              </div>
              <h3 className="mt-5 text-lg font-medium text-ink">{s.t}</h3>
              <p className="mt-2 text-[15px] leading-relaxed text-mute">{s.d}</p>
              <div className="mt-auto pt-6">{s.visual}</div>
            </div>
          );
          if (i === steps.length - 1) return [card];
          return [
            card,
            <div key={`c-${i}`} className="hidden shrink-0 items-center lg:flex">
              <ChevronRight className="size-5 text-faint" />
            </div>,
          ];
        })}
      </div>
    </Section>
  );
}

const claudeIcon = TOOLS.find((t) => t.name === "Claude")!.icon;

function StepPanel({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl border border-line bg-night/50 p-3.5">{children}</div>;
}

function ImportViz() {
  const sources = ["Claude & ChatGPT exports", "Claude Code sessions", "git repos"];
  return (
    <StepPanel>
      <p className="font-mono text-[12px] text-mute">
        <span className="text-electric">$</span> persnally import
      </p>
      <ul className="mt-2.5 space-y-1.5 font-mono text-[11px] text-faint">
        {sources.map((src) => (
          <li key={src} className="flex items-center gap-2">
            <Check className="size-3 shrink-0 text-electric" />
            {src}
          </li>
        ))}
      </ul>
    </StepPanel>
  );
}

function LearnViz() {
  const signals = ["ships the smallest design", "prefers SQLite", "guards user trust"];
  return (
    <StepPanel>
      <p className="font-mono text-[11px] text-faint">building your model…</p>
      <ul className="mt-2.5 space-y-1.5 text-[13px] text-mute">
        {signals.map((sig) => (
          <li key={sig} className="flex items-center gap-2">
            <span className="size-1.5 shrink-0 rounded-full bg-electric" />
            {sig}
          </li>
        ))}
      </ul>
      <span className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-electric/30 bg-electric/10 px-2 py-0.5 font-mono text-[10px] text-electric">
        <Cpu className="size-3" />
        on your machine
      </span>
    </StepPanel>
  );
}

function ServeViz() {
  return (
    <StepPanel>
      <span className="flex items-center gap-2 text-[13px] text-ink">
        <Glyph icon={claudeIcon} className="size-3.5 text-ink" />
        Claude · session started
      </span>
      <div className="mt-3 rounded-lg border border-line bg-surface/60 px-3 py-2.5">
        <p className="font-mono text-[11px] text-electric">↳ loaded your context</p>
        <p className="mt-1 flex items-center gap-1.5 font-mono text-[10px] text-faint">
          persnally_context <Check className="size-3 text-electric" /> 2ms
        </p>
      </div>
    </StepPanel>
  );
}

/* ── AskProof — the answering loop + a real side-by-side ─────── */

function AskProof() {
  return (
    <Section id="ask" className="py-28">
      <div className="max-w-2xl">
        <Eyebrow>Answers, not just recall</Eyebrow>
        <h2 className="mt-5 text-3xl font-semibold leading-tight tracking-tight sm:text-5xl">
          The only context engine your AI can <span className="text-gradient">ask</span>.
        </h2>
        <p className="mt-6 text-lg leading-relaxed text-mute">
          Other tools store facts about you. Persnally answers <em>what you&apos;d do</em> — your
          agents ask it directly, get an answer with a confidence score, and it hands the question
          back to you when the evidence is thin. No confident guessing.
        </p>
      </div>

      {/* the two verified, uncontested capabilities */}
      <div className="mt-12 grid gap-5 md:grid-cols-2">
        <div className="rounded-2xl border border-line bg-surface p-6">
          <h3 className="text-lg font-medium text-ink">It answers, or it defers</h3>
          <p className="mt-2 text-[15px] leading-relaxed text-mute">
            &ldquo;Would they want tests here?&rdquo; &ldquo;What tone for this email?&rdquo; Your
            agent asks Persnally instead of interrupting you. Below its confidence bar it says so and
            sends the agent back to you — never a made-up answer.
          </p>
          <div className="mt-5 rounded-xl border border-line bg-night/50 p-3.5 font-mono text-[12px]">
            <p className="text-mute">persnally_ask <span className="text-faint">&ldquo;tests before I merge?&rdquo;</span></p>
            <p className="mt-2 text-ink">↳ yes — you demand proof before merge; add e2e on the changed paths.</p>
            <p className="mt-1 text-electric">confidence 0.92 · 3 evidence events</p>
          </div>
        </div>
        <div className="rounded-2xl border border-line bg-surface p-6">
          <h3 className="text-lg font-medium text-ink">Correct it once, it sticks</h3>
          <p className="mt-2 text-[15px] leading-relaxed text-mute">
            Tell it it&apos;s wrong about you and the correction becomes authoritative — it outranks
            everything the model inferred, and the wrong answer never comes back. The model gets
            sharper every time you push back.
          </p>
          <div className="mt-5 rounded-xl border border-line bg-night/50 p-3.5 font-mono text-[12px]">
            <p className="text-mute">persnally correct <span className="text-faint">&ldquo;I use pnpm, not npm&rdquo;</span></p>
            <p className="mt-2 text-ink">↳ recorded — authoritative.</p>
            <p className="mt-1 text-electric">every future answer respects it</p>
          </div>
        </div>
      </div>

      {/* the proof: real output, generic AI vs an AI that read your Persnally */}
      <div className="mt-8 overflow-hidden rounded-2xl border border-line bg-surface">
        <div className="border-b border-line px-6 py-4">
          <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-faint">See the difference</p>
          <p className="mt-1.5 text-[15px] text-mute">
            Same prompt — <span className="text-ink">&ldquo;write a Slack message telling my team the deploy went out&rdquo;</span> —
            asked of a blank AI and an AI that read your Persnally:
          </p>
        </div>
        <div className="grid md:grid-cols-2">
          <div className="border-b border-line p-6 md:border-b-0 md:border-r">
            <p className="mb-3 flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-faint">
              <X className="size-3.5" strokeWidth={2} /> Generic AI
            </p>
            <p className="text-[14px] leading-relaxed text-mute">
              🚀 <b className="text-mute">Deploy is live!</b> Just pushed the latest changes to
              production. Everything looks good so far — let me know if you spot anything unexpected.
            </p>
          </div>
          <div className="bg-gradient-to-b from-electric/[0.06] to-transparent p-6">
            <p className="mb-3 flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-electric">
              <Check className="size-3.5" strokeWidth={2.25} /> AI + Persnally
            </p>
            <p className="text-[14px] leading-relaxed text-ink">
              deploy is out. watching sentry/logs for the next hour, will confirm clean or flag
              issues here.
            </p>
          </div>
        </div>
      </div>
      <p className="mt-4 text-center text-[13px] text-faint">
        Terse, lowercase, no emoji, and it knew to watch Sentry — because that&apos;s how you actually
        work. Not configured; learned.
      </p>
    </Section>
  );
}

/* ── Compare — the honest, verified capability table ─────────── */

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
    m === "y" ? <Check className="mx-auto size-4 text-electric" strokeWidth={2.5} />
    : m === "p" ? <Minus className="mx-auto size-4 text-faint" strokeWidth={2} />
    : <X className="mx-auto size-4 text-line" strokeWidth={2} />;

  return (
    <Section id="compare" className="py-28">
      <div className="max-w-2xl">
        <Eyebrow>How it compares</Eyebrow>
        <h2 className="mt-5 text-3xl font-semibold leading-tight tracking-tight sm:text-5xl">
          Everyone remembers. Persnally <span className="text-gradient">answers</span>.
        </h2>
        <p className="mt-6 text-lg leading-relaxed text-mute">
          The category is full of memory. What no one else does: answer what you&apos;d do, learn when
          you correct it, and let you verify all of it on your own machine.
        </p>
      </div>

      <div className="mt-12 overflow-x-auto rounded-2xl border border-line bg-surface">
        <table className="w-full min-w-[680px] border-collapse text-left">
          <thead>
            <tr className="border-b border-line">
              <th className="p-4 text-[13px] font-normal text-faint">Capability</th>
              {cols.map((c, i) => (
                <th
                  key={c}
                  className={`p-4 text-center text-[13px] font-medium ${i === 0 ? "text-electric" : "text-mute"}`}
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.cap} className="border-b border-line/60 last:border-0">
                <td className="p-4 text-[14px] leading-snug text-ink">{r.cap}</td>
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

      <p className="mx-auto mt-6 max-w-3xl text-center text-[13px] leading-relaxed text-faint">
        <Check className="inline size-3 text-electric" /> has it ·{" "}
        <Minus className="inline size-3 text-faint" /> partial ·{" "}
        <X className="inline size-3 text-line" /> no. Verified against each product&apos;s own docs and
        repos, July 2026. claude-mem is genuinely local and open-source too — our edge isn&apos;t
        custody alone, it&apos;s the answering loop and modeling <em>you</em> across every AI, not just
        your code.
      </p>
    </Section>
  );
}

/* ── Trust — spotlight bento ─────────────────────────────────── */

function Trust() {
  const pillars = [
    {
      t: "Local-first",
      d: "Your context lives in ~/.persnally on your machine — not our cloud, not any vendor's silo. Serving it to an AI is a local read: instant, offline, free.",
      viz: <LocalProof />,
    },
    {
      t: "Truly deletable",
      d: "Forget a topic and it erases the events and everything derived from them, then rebuilds. No tombstones, no residue.",
      viz: <DeleteProof />,
    },
    {
      t: "Provenance-complete",
      d: "Every claim links to the exact events behind it. “Why does it think this?” is a real lookup, never a guess.",
      viz: <AuditProof />,
    },
    {
      t: "Source-available",
      d: "Read the engine, audit the claims, run it yourself. The event schema and MCP interface are an open spec.",
      viz: <SourceProof />,
    },
  ];
  return (
    <Section id="trust" className="py-28">
      <div className="max-w-2xl">
        <Eyebrow>Your data, your rules</Eyebrow>
        <h2 className="mt-5 text-3xl font-semibold leading-tight tracking-tight sm:text-5xl">
          A context engine you can actually trust.
        </h2>
        <p className="mt-6 text-lg leading-relaxed text-mute">
          Trust isn&apos;t a privacy policy here — it&apos;s the architecture. Not promises;
          properties you can check.
        </p>
      </div>

      <div className="mt-14 grid gap-5 md:grid-cols-2">
        {pillars.map((p) => (
          <SpotlightCard key={p.t} className="p-6">
            <h3 className="text-lg font-medium text-ink">{p.t}</h3>
            <p className="mt-2 text-[15px] leading-relaxed text-mute">{p.d}</p>
            <div className="mt-5">{p.viz}</div>
          </SpotlightCard>
        ))}
      </div>

      <div className="mt-6 flex flex-col items-center gap-6 rounded-2xl border border-line bg-surface/50 p-8 text-center">
        <div className="flex flex-wrap justify-center gap-2.5">
          {["No account", "Bring your own keys", "Works offline", "Open spec"].map((c) => (
            <span
              key={c}
              className="inline-flex items-center gap-1.5 rounded-full border border-line bg-night/40 px-3 py-1 font-mono text-[11px] text-mute"
            >
              <Check className="size-3 text-electric" />
              {c}
            </span>
          ))}
        </div>
        <a
          href={GITHUB}
          {...EXT}
          className="group inline-flex items-center gap-1.5 text-sm text-mute transition-colors hover:text-ink"
        >
          <GithubIcon className="size-3.5" />
          Read the source
          <ArrowUpRight className="size-3 shrink-0 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
        </a>
      </div>
    </Section>
  );
}

function ProofPanel({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl border border-line bg-night/50 p-3.5">{children}</div>;
}

function LocalProof() {
  const files = [
    { icon: <Database className="size-3.5" />, name: "persnally.db" },
    { icon: <FileJson className="size-3.5" />, name: "config.json" },
  ];
  return (
    <ProofPanel>
      <p className="font-mono text-[11px] text-faint">~/.persnally</p>
      <ul className="mt-2.5 space-y-1.5 font-mono text-[12px] text-mute">
        {files.map((f) => (
          <li key={f.name} className="flex items-center gap-2">
            <span className="text-electric">{f.icon}</span>
            {f.name}
          </li>
        ))}
      </ul>
      <p className="mt-3 font-mono text-[10px] text-faint">stays on your machine, never our cloud</p>
    </ProofPanel>
  );
}

function DeleteProof() {
  return (
    <ProofPanel>
      <p className="font-mono text-[12px] text-mute">
        <span className="text-electric">$</span> persnally forget “rust”
      </p>
      <ul className="mt-2.5 space-y-1.5 font-mono text-[11px] text-faint">
        <li className="flex items-center gap-2">
          <Check className="size-3 shrink-0 text-electric" />
          18 events erased
        </li>
        <li className="flex items-center gap-2">
          <Check className="size-3 shrink-0 text-electric" />
          derived views rebuilt
        </li>
      </ul>
      <p className="mt-2.5 font-mono text-[10px] text-faint">no tombstones · no residue</p>
    </ProofPanel>
  );
}

function AuditProof() {
  const events = [
    { id: "#412", t: "vetoed telemetry" },
    { id: "#087", t: "chose local-first" },
    { id: "#203", t: "removed analytics" },
  ];
  return (
    <ProofPanel>
      <p className="font-mono text-[11px] text-electric">↳ why “guards user trust”?</p>
      <ul className="mt-2.5 space-y-1.5 font-mono text-[11px] text-mute">
        {events.map((e) => (
          <li key={e.id} className="flex items-center gap-2">
            <span className="text-faint">{e.id}</span>
            {e.t}
          </li>
        ))}
      </ul>
      <p className="mt-2.5 font-mono text-[10px] text-faint">3 events · 0 guesses</p>
    </ProofPanel>
  );
}

function SourceProof() {
  return (
    <a
      href={GITHUB}
      {...EXT}
      className="group block rounded-xl border border-line bg-night/50 p-3.5 transition-colors hover:border-electric/40"
    >
      <div className="flex items-center gap-2 text-ink">
        <GithubIcon className="size-4" />
        <span className="font-mono text-[12px]">persnally/persnally</span>
        <ArrowUpRight className="ml-auto size-3.5 text-faint transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
      </div>
      <div className="mt-2.5 flex items-center gap-3 font-mono text-[10px] text-faint">
        <span className="flex items-center gap-1">
          <Star className="size-3" />
          star
        </span>
        <span>FSL → MIT after 2y</span>
        <span>open spec</span>
      </div>
    </a>
  );
}

/* ── Positioning ─────────────────────────────────────────────── */

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
    <Section className="py-28">
      <div className="relative overflow-hidden rounded-3xl border border-line bg-gradient-to-b from-panel/50 to-surface px-6 py-20 sm:px-10">
        <div className="pointer-events-none absolute inset-0 -z-10 opacity-40">
          <div className="aurora" style={{ height: "100%", opacity: 0.28 }} />
        </div>

        <div className="text-center">
          <Eyebrow>The difference</Eyebrow>
          <p className="mx-auto mt-6 max-w-3xl text-balance text-[1.9rem] font-semibold leading-tight tracking-tight sm:text-[2.9rem] sm:leading-[1.1]">
            Every AI knows <span className="text-mute">you.</span>
            <br className="hidden sm:block" /> And it&apos;s{" "}
            <span className="text-gradient">yours.</span>
          </p>
        </div>

        <div className="mx-auto mt-14 grid max-w-3xl gap-5 md:grid-cols-2">
          <div className="rounded-2xl border border-line bg-night/40 p-7">
            <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-faint">
              Every other memory tool
            </p>
            <p className="mt-1.5 text-sm italic text-faint">“a place to store facts about you”</p>
            <ul className="mt-6 space-y-3.5">
              {them.map((x) => (
                <li key={x} className="flex items-start gap-3 text-[15px] text-mute">
                  <X className="mt-0.5 size-4 shrink-0 text-faint" strokeWidth={2} />
                  {x}
                </li>
              ))}
            </ul>
          </div>

          <div className="border-glow rounded-2xl border border-electric/30 bg-gradient-to-b from-electric/[0.07] to-surface p-7">
            <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-electric">Persnally</p>
            <p className="mt-1.5 text-sm text-mute">your own context engine</p>
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

        <p className="mx-auto mt-10 max-w-xl text-center text-sm leading-relaxed text-faint">
          Everyone can remember facts about you. Persnally is the one your AI can <em>ask</em> — it
          answers what you&apos;d do, defers when it&apos;s unsure, and learns the moment you correct
          it. All of it on your machine, and yours.
        </p>

        <div className="mt-8 flex justify-center">
          <a
            href="#start"
            className="rounded-lg bg-electric px-5 py-2.5 text-sm font-medium text-white shadow-[0_0_28px_-6px_var(--color-electric)] transition-colors hover:bg-electric-deep"
          >
            Make every AI yours
          </a>
        </div>
      </div>
    </Section>
  );
}

/* ── Pricing ─────────────────────────────────────────────────── */

function Pricing() {
  const free = [
    "The full engine — import, learn, synthesize your profile",
    "Serve your context to every AI over MCP",
    "The dashboard: inspect, audit provenance, delete",
    "Bring your own key, or run fully local with Ollama",
  ];
  return (
    <Section id="pricing" className="py-28">
      <div className="mx-auto max-w-2xl text-center">
        <Eyebrow>Pricing</Eyebrow>
        <h2 className="mt-5 text-3xl font-semibold leading-tight tracking-tight sm:text-5xl">
          The engine is free. Forever.
        </h2>
        <p className="mt-6 text-lg leading-relaxed text-mute">
          Everything that touches your data runs on your machine and costs nothing. Pro adds cloud
          conveniences on top — and the cloud only ever carries ciphertext, never your plaintext.
        </p>
      </div>

      <div className="mx-auto mt-14 grid max-w-3xl gap-5 md:grid-cols-2">
        <div className="flex flex-col rounded-2xl border border-line bg-night/40 p-7">
          <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-faint">Free</p>
          <p className="mt-3 text-3xl font-semibold text-ink">
            $0 <span className="text-sm font-normal text-faint">forever</span>
          </p>
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
              className="block rounded-xl border border-line bg-surface/60 px-4 py-2.5 text-center text-sm font-medium text-ink transition-colors hover:border-electric/50"
            >
              Install now
            </a>
          </div>
        </div>

        <ProCard />
      </div>

      <p className="mx-auto mt-10 max-w-xl text-center text-sm leading-relaxed text-faint">
        Privacy is never the paid tier. The local engine, the dashboard, and deletion stay free —
        Pro is convenience on top, not a wall around your own data.
      </p>
    </Section>
  );
}

/* ── Get started ─────────────────────────────────────────────── */

function GetStarted() {
  return (
    <Section id="start" className="relative overflow-hidden py-28">
      <div className="pointer-events-none absolute left-1/2 top-8 h-[420px] w-[680px] max-w-full -translate-x-1/2 rounded-full bg-electric/10 blur-[130px]" />
      <div className="relative mx-auto max-w-2xl text-center">
        <Eyebrow>Five minutes to your mirror</Eyebrow>
        <h2 className="mt-5 text-3xl font-semibold leading-tight tracking-tight sm:text-5xl">
          Install, and see yourself.
        </h2>
        <p className="mt-6 text-lg leading-relaxed text-mute">
          One command finds your exports, reads your repos, synthesizes a profile, connects your AI
          clients, and opens the dashboard.
        </p>
      </div>

      <div className="relative mx-auto mt-10 max-w-2xl">
        <SetupTabs />
        <p className="mt-5 text-center font-mono text-[12px] text-faint">
          macOS · Linux · Windows · Node 20+ · background autostart on macOS &amp; Linux · bring your own key, or run fully local with Ollama
        </p>
        <div className="mt-6 flex justify-center">
          <a
            href={GITHUB}
            {...EXT}
            className="group inline-flex items-center gap-1.5 text-sm text-mute transition-colors hover:text-ink"
          >
            <GithubIcon className="size-4" />
            Read the source
            <ArrowUpRight className={arrowCls} />
          </a>
        </div>
      </div>
    </Section>
  );
}

/* ── Footer ──────────────────────────────────────────────────── */

function Footer() {
  return (
    <footer className="relative overflow-hidden border-t border-line/60">
      <Section className="flex flex-col items-start justify-between gap-8 pt-14 sm:flex-row sm:items-center">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-faint">
            © 2026 Persnally
          </p>
          <p className="mt-2.5 text-xl font-medium tracking-tight text-ink">
            So every AI finally knows <span className="text-gradient">you</span>.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-x-7 gap-y-3 text-sm text-mute">
          <a
            href={GITHUB}
            {...EXT}
            className="group flex items-center gap-1.5 transition-colors hover:text-ink"
          >
            <GithubIcon className="size-4" />
            GitHub
            <ArrowUpRight className={arrowCls} />
          </a>
          <a
            href={NPM}
            {...EXT}
            className="group flex items-center gap-1.5 transition-colors hover:text-ink"
          >
            <NpmIcon className="size-4" />
            npm
            <ArrowUpRight className={arrowCls} />
          </a>
          <a
            href={`${GITHUB}/blob/main/LICENSE`}
            {...EXT}
            className="group flex items-center gap-1 transition-colors hover:text-ink"
          >
            FSL-1.1-MIT
            <ArrowUpRight className={arrowCls} />
          </a>
        </div>
      </Section>

      {/* Giant brand wordmark — bold, full-bleed, subtle */}
      <div aria-hidden className="pointer-events-none mt-8 select-none px-6">
        <span className="block translate-y-[12%] bg-gradient-to-b from-ink/[0.10] to-ink/[0.02] bg-clip-text text-center text-[clamp(4rem,21vw,17rem)] font-bold leading-[0.8] tracking-tight text-transparent">
          persnally
          <span className="bg-gradient-to-b from-electric/60 to-electric/10 bg-clip-text text-transparent">
            .
          </span>
        </span>
      </div>
    </footer>
  );
}
