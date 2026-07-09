import { Check, Cpu, GitBranch, Lock, Network, ScanSearch, ShieldCheck, type LucideIcon } from "lucide-react";
import { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Glyph, TOOLS } from "@/components/ui/logos";

const icon = (name: string) => TOOLS.find((t) => t.name === name)!.icon;

export function Features() {
  return (
    <section className="py-28">
      <div className="mx-auto max-w-6xl px-6">
        <div className="mx-auto max-w-2xl text-center">
          <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-electric">Under the hood</span>
          <h2 className="mt-5 text-3xl font-semibold tracking-tight text-ink sm:text-5xl">
            More than memory. An engine.
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-mute">
            Structured events, derived views, and a walkable provenance graph — explainable,
            decay-aware, and entirely your own.
          </p>
        </div>

        <div className="mx-auto mt-14 grid gap-4 lg:grid-cols-2">
          <BentoCell>
            <CardHeading icon={Network} title="Cross-vendor · MCP" description="One context, every tool reads it." />
            <div className="border-t border-line/60 p-6 md:p-7">
              <div className="flex items-center justify-between px-0.5 pb-3">
                <span className="font-mono text-[11px] text-faint">persnallyd · MCP</span>
                <span className="inline-flex items-center gap-1.5 font-mono text-[10px] text-electric">
                  <span className="size-1.5 animate-pulse rounded-full bg-electric" />
                  serving
                </span>
              </div>
              <div className="space-y-2">
                <McpRow iconNode={<Glyph icon={icon("Claude")} className="size-4 text-ink" />} name="Claude" method="persnally_context" />
                <McpRow iconNode={<Glyph icon={icon("Cursor")} className="size-4 text-ink" />} name="Cursor" method="persnally_context" />
                <McpRow iconNode={<Glyph icon={icon("Claude")} className="size-4 text-ink" />} name="Claude Code" method="persnally_ask" />
                <McpRow iconNode={<Cpu className="size-4 text-electric" />} name="your agent" method="persnally_search" />
              </div>
              <p className="mt-4 text-center font-mono text-[11px] text-faint">
                speaks MCP — adopted by every major AI
              </p>
            </div>
          </BentoCell>

          <BentoCell>
            <CardHeading icon={ScanSearch} title="Provenance" description="Every claim cites its evidence." />
            <div className="border-t border-line/60 p-6 md:p-7">
              <div className="rounded-xl border border-line bg-night/40 p-4">
                <p className="text-sm leading-snug text-ink">Guards user trust as non-negotiable.</p>
                <div className="mt-2.5 flex items-center gap-2">
                  <span className="font-mono text-[11px] text-electric">↳ why does it think this?</span>
                  <span className="rounded-md border border-line px-2 py-0.5 font-mono text-[11px] text-faint">3 events</span>
                </div>
              </div>
              <ul className="mt-4 space-y-2.5 border-l border-line pl-4">
                <EvidenceRow icon={<Glyph icon={icon("Claude")} className="size-3.5 text-ink" />} label="Imported 142 Claude conversations" />
                <EvidenceRow icon={<GitBranch className="size-3.5" />} label="Vetoed telemetry without consent" />
                <EvidenceRow icon={<ShieldCheck className="size-3.5" />} label="Chose local-first storage" />
              </ul>
            </div>
          </BentoCell>

          <BentoCell className="lg:col-span-2">
            <CardHeading icon={Lock} title="Per-client scopes" description="Decide exactly what each AI can see." />
            <div className="grid gap-2 border-t border-line/60 p-6 sm:grid-cols-2 md:p-7">
              <ScopeRow name="Claude" iconNode={<Glyph icon={icon("Claude")} className="size-4 text-ink" />} state="allowed" />
              <ScopeRow name="Cursor" iconNode={<Glyph icon={icon("Cursor")} className="size-4 text-ink" />} state="allowed" />
              <ScopeRow name="Claude Code" iconNode={<Glyph icon={icon("Claude")} className="size-4 text-ink" />} state="scoped" />
              <ScopeRow name="agents" iconNode={<Cpu className="size-4 text-electric" />} state="scoped" />
            </div>
          </BentoCell>
        </div>
      </div>
    </section>
  );
}

function BentoCell({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("relative overflow-hidden rounded-2xl border border-line bg-surface", className)}>{children}</div>
  );
}

function CardHeading({ icon: Icon, title, description }: { icon: LucideIcon; title: string; description: string }) {
  return (
    <div className="p-6 md:p-7">
      <span className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.16em] text-electric">
        <Icon className="size-4" />
        {title}
      </span>
      <p className="mt-5 text-xl font-semibold text-ink">{description}</p>
    </div>
  );
}

function McpRow({ iconNode, name, method }: { iconNode: ReactNode; name: string; method: string }) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-line bg-night/40 px-3.5 py-2.5">
      <span className="flex items-center gap-2.5 text-sm text-ink">
        {iconNode}
        {name}
      </span>
      <span className="flex items-center gap-2 font-mono text-[11px] text-mute">
        {method}
        <Check className="size-3.5 text-electric" />
      </span>
    </div>
  );
}

function EvidenceRow({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <li className="flex items-center gap-2.5 text-[13px] text-mute">
      <span className="grid size-6 shrink-0 place-items-center rounded-md bg-electric/15 text-electric">{icon}</span>
      {label}
    </li>
  );
}

const SCOPE: Record<string, { label: string; dot: string; pill: string }> = {
  allowed: { label: "Allowed", dot: "bg-electric", pill: "border-electric/30 bg-electric/15 text-electric" },
  scoped: { label: "Scoped", dot: "bg-mute", pill: "border-line bg-line/40 text-mute" },
  hidden: { label: "Hidden", dot: "bg-faint/60", pill: "border-line text-faint" },
};

function ScopeRow({ name, iconNode, state }: { name: string; iconNode: ReactNode; state: keyof typeof SCOPE }) {
  const s = SCOPE[state];
  return (
    <div className="flex items-center justify-between rounded-xl border border-line bg-night/40 px-4 py-3">
      <span className="flex items-center gap-2.5 text-sm text-ink">{iconNode}{name}</span>
      <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[11px]", s.pill)}>
        <span className={cn("size-1.5 rounded-full", s.dot)} />
        {s.label}
      </span>
    </div>
  );
}
