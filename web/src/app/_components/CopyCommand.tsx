"use client";

import { useState } from "react";

export function CopyCommand({ command, className = "" }: { command: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked — the command is still visible to select */
    }
  };

  return (
    <button
      onClick={copy}
      aria-label={`Copy: ${command}`}
      className={`terminal group flex items-center gap-3 rounded-[2px] px-4 py-3.5 text-left ${className}`}
    >
      <span className="select-none font-mono text-electric-glow" aria-hidden>
        $
      </span>
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[12px] sm:text-[13.5px] [scrollbar-width:none]">
        {command}
      </code>
      <span
        className={`shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] transition-opacity ${
          copied ? "text-electric-glow" : "opacity-50 group-hover:opacity-90"
        }`}
      >
        {copied ? "copied" : "copy"}
      </span>
    </button>
  );
}
