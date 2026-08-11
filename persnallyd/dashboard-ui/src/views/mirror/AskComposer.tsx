import { useRef, useState } from "preact/hooks";
import type { PersnallyClient } from "../../api/client";
import type { AskResult } from "../../api/types";
import { pct } from "../../lib/format";
import { EvidenceWalk } from "./EvidenceWalk";

/**
 * The composer over your own model — the same POST /ask agents call over MCP,
 * dogfooded on the trust surface. Distinct states: answered, deferred (with
 * the server's reason), rate-limited (20/10min, no Retry-After → 60s local
 * cooldown), transport error.
 */

const MAX = 500;

type Entry = { question: string; result: AskResult };

const DEFER_COPY: Record<string, string> = {
  "low-confidence": "It deferred rather than guess — an agent would be sent back to ask you directly.",
  "not-enough-context": "Not enough evidence on file to answer this. Import more history, or let connected clients stream context.",
  "no-engine": "No extraction engine is configured — set one up on the classic dashboard or run persnally setup.",
};

export function AskComposer({ client }: { client: PersnallyClient }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [openEvidence, setOpenEvidence] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  const cooled = Date.now() < cooldownUntil;
  const sendable = q.trim().length >= 1 && q.length <= MAX && !busy && !cooled;

  async function send() {
    if (!sendable) return;
    setBusy(true);
    setNotice(null);
    setError(null);
    const question = q.trim();
    const r = await client.ask(question);
    setBusy(false);
    if (r.kind === "ok") {
      setEntries((prev) => [{ question, result: r.result }, ...prev]);
      setQ("");
    } else if (r.kind === "rate-limited") {
      setNotice(r.message);
      setCooldownUntil(Date.now() + 60_000);
      setTimeout(() => setCooldownUntil(0), 60_000);
    } else {
      setError(r.message);
    }
    box.current?.focus();
  }

  return (
    <div class="reveal">
      <div class="ask">
        <textarea
          ref={box}
          value={q}
          maxLength={MAX + 50}
          placeholder='Ask what your model would say — "npm or pnpm?", "would I want tests here?"'
          disabled={busy}
          onInput={(e) => setQ((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div class="ask-foot">
          <span class="ask-count num">
            {q.length}/{MAX}
          </span>
          {client.mode === "demo" && <span class="ask-count">sample mode</span>}
          <button class="ask-send" disabled={!sendable} onClick={() => void send()}>
            {busy ? "asking…" : cooled ? "cooling down" : "Ask"}
          </button>
        </div>
      </div>

      {notice && <div class="notice">{notice}</div>}
      {error && (
        <div class="error-text">
          {error}{" "}
          <button class="link-btn" onClick={() => void send()}>
            retry
          </button>
        </div>
      )}

      {entries.map((e) => (
        <div key={e.result.answer_id} class={`answer${e.result.deferred ? " deferred" : ""}`}>
          <div class="q">{e.question}</div>
          <div class="a">{e.result.answer}</div>
          <div class="meta">
            {!e.result.deferred && (
              <span class="conf num" title={`confidence ${e.result.confidence.toFixed(2)}`}>
                <span class="conf-bar">
                  <span
                    class={`conf-fill${e.result.confidence >= 0.7 ? " high" : ""}`}
                    style={`width:${Math.round(e.result.confidence * 100)}%`}
                  />
                </span>
                {pct(e.result.confidence)}
              </span>
            )}
            {e.result.deferred && <span>deferred{e.result.reason ? ` · ${e.result.reason}` : ""}</span>}
            {e.result.evidence_event_ids.length > 0 && (
              <button
                class="link-btn"
                onClick={() => setOpenEvidence(openEvidence === e.result.answer_id ? null : e.result.answer_id)}
              >
                evidence · {e.result.evidence_event_ids.length}
              </button>
            )}
            {client.mode === "live" && !e.result.deferred && <span>logged to your asks</span>}
          </div>
          {e.result.deferred && e.result.reason && <div class="body-text" style="margin-top:6px;font-size:13.5px">{DEFER_COPY[e.result.reason]}</div>}
          {e.result.evidence_event_ids.length > 0 && (
            <EvidenceWalk client={client} ids={e.result.evidence_event_ids} open={openEvidence === e.result.answer_id} />
          )}
        </div>
      ))}
    </div>
  );
}
