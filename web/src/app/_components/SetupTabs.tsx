"use client";

import { useState } from "react";

const COMMAND = "npm i -g persnally && persnally setup";

const PROMPT = `Set up Persnally for me — a local-first context engine that gives you (my AI tools) personal context about who I am and what I'm working on, served over MCP and stored only on my machine.

1. Run: npm i -g persnally
2. Run: persnally setup   (imports my AI history, builds my profile, and connects this client over MCP)
3. Confirm the persnally MCP tools are available, then call persnally_context at the start of our sessions.

When it's done, tell me what it learned about me.`;

type Tab = "terminal" | "ai";

export function SetupTabs() {
  const [tab, setTab] = useState<Tab>("terminal");
  const [copied, setCopied] = useState(false);

  const text = tab === "terminal" ? COMMAND : PROMPT;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked — content is still selectable */
    }
  };

  return (
    <div className="w-full">
      {/* editorial tabs: mono labels, active gets the ink underline */}
      <div role="tablist" aria-label="Setup method" className="mx-auto flex w-fit items-center gap-6 border-b border-ink/25">
        {(
          [
            ["terminal", "Terminal"],
            ["ai", "Ask your AI"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => {
              setTab(key);
              setCopied(false);
            }}
            className={`-mb-px border-b-2 px-1 pb-2 font-mono text-[12px] uppercase tracking-[0.12em] transition-colors ${
              tab === key ? "border-ink text-ink" : "border-transparent text-faint hover:text-mute"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* panel */}
      <div className="terminal relative mt-5 rounded-[2px]">
        <button
          onClick={copy}
          aria-label="Copy"
          className={`absolute right-3 top-3 z-10 border border-paper/25 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] transition-opacity ${
            copied ? "text-electric-glow" : "opacity-60 hover:opacity-100"
          }`}
        >
          {copied ? "copied" : "copy"}
        </button>

        {tab === "terminal" ? (
          <div className="flex items-center gap-3 px-4 py-3.5 pr-16">
            <span className="select-none font-mono text-electric-glow" aria-hidden>
              $
            </span>
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[12px] sm:text-[13.5px] [scrollbar-width:none]">
              {COMMAND}
            </code>
          </div>
        ) : (
          <pre className="whitespace-pre-wrap break-words px-4 py-4 pr-16 font-mono text-[12.5px] leading-relaxed opacity-90">
            {PROMPT}
          </pre>
        )}
      </div>

      <p className="mt-3 text-center text-[14px] italic text-faint">
        {tab === "terminal"
          ? "Paste in your terminal."
          : "Paste into Claude Code, Cursor, or any agent — let it set itself up."}
      </p>
    </div>
  );
}
