import { useState } from "preact/hooks";
import type { PersnallyClient } from "../../api/client";
import type { AskResult } from "../../api/types";
import { pct } from "../../lib/format";
import { EvidenceWalk } from "./EvidenceWalk";

/** One question and what your model answered — rendered in the content flow,
    under the portrait, so the pair reads as a continuing conversation. */

const DEFER_COPY: Record<string, string> = {
  "low-confidence": "It deferred rather than guess — an agent would be sent back to ask you directly.",
  "not-enough-context": "Not enough evidence on file to answer this. Import more history, or let connected clients stream context.",
  "no-engine": "No extraction engine is configured — set one up on the classic dashboard, or run persnally setup.",
};

export function AskEntry({
  client,
  question,
  result,
  label,
  onClose,
}: {
  client: PersnallyClient;
  question: string;
  result: AskResult;
  /** Provenance line for an ask opened from history (asker, when, verdict). */
  label?: string;
  onClose?: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div class={`ask-entry reveal${result.deferred ? " deferred" : ""}`}>
      {label && (
        <div class="ask-label">
          <span>{label}</span>
          {onClose && (
            <button class="link-btn" onClick={onClose} title="Close this ask">
              close
            </button>
          )}
        </div>
      )}
      <div class="q">{question}</div>
      <div class="a">{result.deferred && !result.answer ? "Deferred — no answer was given." : result.answer}</div>
      {result.deferred && result.reason && <div class="defer-note">{DEFER_COPY[result.reason]}</div>}
      <div class="ask-meta">
        {result.deferred ? (
          <span>deferred{result.reason ? ` · ${result.reason}` : ""}</span>
        ) : (
          <span class="conf num" title={`confidence ${result.confidence.toFixed(2)}`}>
            <span class="conf-bar">
              <span class={`conf-fill${result.confidence >= 0.7 ? " high" : ""}`} style={`width:${Math.round(result.confidence * 100)}%`} />
            </span>
            {pct(result.confidence)}
          </span>
        )}
        {result.evidence_event_ids.length > 0 && (
          <button class="link-btn" onClick={() => setOpen(!open)}>
            evidence · {result.evidence_event_ids.length}
          </button>
        )}
        {client.mode === "live" && !result.deferred && <span>logged to your asks</span>}
      </div>
      {result.evidence_event_ids.length > 0 && <EvidenceWalk client={client} ids={result.evidence_event_ids} open={open} />}
    </div>
  );
}
