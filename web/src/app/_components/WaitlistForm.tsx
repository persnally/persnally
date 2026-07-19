"use client";

import { useState } from "react";

type State = "idle" | "sending" | "done" | "error";

export function WaitlistForm({ plan, amount }: { plan?: "monthly" | "annual"; amount?: number }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<State>("idle");
  const [message, setMessage] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (state === "sending" || state === "done") return;
    setState("sending");
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, plan, amount }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setState("error");
        setMessage(body.error ?? "Something went wrong — please try again.");
        return;
      }
      setState("done");
      window.op?.("track", "waitlist_joined", { plan, amount });
    } catch {
      setState("error");
      setMessage("Network error — please try again.");
    }
  };

  if (state === "done") {
    return (
      <p className="border border-electric/40 px-4 py-3 text-center text-sm text-ink">
        You&apos;re on the list — we&apos;ll email you when Pro opens.
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2.5">
      <div className="flex gap-2.5">
        <input
          type="email"
          required
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (state === "error") setState("idle");
          }}
          placeholder="you@example.com"
          aria-label="Email address"
          className="min-w-0 flex-1 rounded-[2px] border border-ink/40 bg-paper px-4 py-2.5 text-sm text-ink placeholder:text-faint focus:border-electric focus:outline-none"
        />
        <button
          type="submit"
          disabled={state === "sending"}
          className="shrink-0 rounded-[2px] bg-electric px-4 py-2.5 font-mono text-[11px] uppercase tracking-[0.12em] text-paper transition-colors hover:bg-electric-deep disabled:opacity-60"
        >
          {state === "sending" ? "Joining…" : "Join waitlist"}
        </button>
      </div>
      {state === "error" && <p className="text-xs text-red-700">{message}</p>}
    </form>
  );
}
