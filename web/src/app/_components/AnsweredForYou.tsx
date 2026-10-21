/* The hero plate: three real rows from the founder's own ledger — Claude Code
   asked Persnally instead of asking him. Text is verbatim from the store,
   trimmed with an ellipsis; dates, confidence and evidence counts as logged.
   Not a mockup: change these only by replacing them with newer real rows. */

const ROWS: {
  date: string;
  question: string;
  answer: string;
  confidence: number;
  evidence: number;
  sentBack?: boolean;
}[] = [
  {
    date: "25 Aug 2026",
    question:
      "For a new lightweight mobile-first web frontend served by a Go JSON API (hackathon, 2-day deadline), would Sidhanth pick Vite + Preact + TypeScript over htmx/templ or SvelteKit/Next?…",
    answer:
      "yes, Vite + Preact + TypeScript — you've already rejected Next/SPA for 3G budgets and migrated htmx to this exact stack.…",
    confidence: 0.87,
    evidence: 3,
  },
  {
    date: "3 Sep 2026",
    question:
      "For the Persnally Claude Code plugin: would this user accept the MCP adapter reading the client's identity token from ~/.persnally/config.json when no token env is present…",
    answer:
      "Don't accept the shared identity-token path. Require each MCP client to present its own secret from its launching config…",
    confidence: 0.78,
    evidence: 4,
  },
  {
    date: "22 Jul 2026",
    question:
      "When cutting over a production money-path from v1 to v2, does Sidhanth prefer a reversible, flag-gated change that keeps an escape hatch, or a clean full removal of the old flag/branches in one step?",
    answer: "no evidence found … defer to Sidhanth directly rather than guess.",
    confidence: 0.25,
    evidence: 0,
    sentBack: true,
  },
];

export function AnsweredForYou() {
  return (
    <figure className="terminal rounded-[2px] p-5 sm:p-6">
      <p className="flex items-baseline justify-between gap-4 font-mono text-[11px] uppercase tracking-[0.14em] opacity-60">
        <span>answers</span>
        <span className="normal-case tracking-normal">claude code → persnally</span>
      </p>
      <ol className="mt-4 divide-y divide-paper/15">
        {ROWS.map((r) => (
          <li key={r.date} className="py-4 first:pt-0 last:pb-0">
            <p className="font-mono text-[11px] opacity-60">claude code asked · {r.date}</p>
            <p className="mt-1.5 font-mono text-[12.5px] leading-relaxed opacity-85">{r.question}</p>
            <p className={`mt-2 font-mono text-[12.5px] leading-relaxed ${r.sentBack ? "opacity-60" : ""}`}>
              ↳ {r.answer}
            </p>
            <p className={`mt-1.5 font-mono text-[11px] ${r.sentBack ? "opacity-85" : "opacity-60"}`}>
              {r.sentBack
                ? `sent back to you · confidence ${r.confidence.toFixed(2)} · below the bar`
                : `answered for you · confidence ${r.confidence.toFixed(2)} · ${r.evidence} evidence events`}
            </p>
          </li>
        ))}
      </ol>
      <figcaption className="mt-5 border-t border-paper/15 pt-3 font-mono text-[11px] leading-relaxed opacity-60">
        Real rows from the founder&apos;s store, verbatim. Claude Code has asked it 19 times: 7 answered, 12 sent back.
        Seven questions he never had to answer.
      </figcaption>
    </figure>
  );
}
