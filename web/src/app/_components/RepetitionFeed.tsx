"use client";

import { MotionConfig } from "motion/react";
import { RotateCw } from "lucide-react";
import { AnimatedList } from "@/components/magicui/animated-list";
import { Glyph, brand, type BrandName } from "@/components/ui/logos";

/* The interruption tax: tool after tool stopping to ask what you already told
   another one, stacking up via Magic UI AnimatedList. Each meets you as a stranger. */

const icon = (name: BrandName) => brand(name);

const MESSAGES: { id: string; tool: BrandName; to: string; text: string }[] = [
  { id: "m1", tool: "Claude", to: "Claude", text: "Which framework should I scaffold this with?" },
  { id: "m2", tool: "ChatGPT", to: "ChatGPT", text: "Do you want Postgres or SQLite here?" },
  { id: "m3", tool: "Cursor", to: "Cursor", text: "Should I add tests before this lands?" },
  { id: "m4", tool: "Copilot", to: "Copilot", text: "How strict should the auth check be?" },
  { id: "m5", tool: "Claude", to: "Claude · new chat", text: "Quick question before I start: what's your stack?" },
];

function Message({ tool, to, text }: { tool: BrandName; to: string; text: string }) {
  return (
    <div className="plate w-full p-3.5">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.1em] text-mute">
          <Glyph icon={icon(tool)} className="size-3.5 text-ink" />
          {to} asks
        </span>
        <span className="inline-flex shrink-0 items-center gap-1 border border-ink/25 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-faint">
          <RotateCw className="size-3" /> answered before
        </span>
      </div>
      <p className="mt-2 text-[15px] italic leading-snug text-ink">“{text}”</p>
    </div>
  );
}

export function RepetitionFeed() {
  return (
    <MotionConfig reducedMotion="user">
      <div className="relative max-h-[400px] overflow-hidden">
        <AnimatedList delay={1300} className="items-stretch gap-3">
          {MESSAGES.map((m) => (
            <Message key={m.id} tool={m.tool} to={m.to} text={m.text} />
          ))}
        </AnimatedList>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-paper to-transparent" />
      </div>
    </MotionConfig>
  );
}
