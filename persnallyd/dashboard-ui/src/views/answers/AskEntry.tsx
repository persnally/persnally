import { useState } from "preact/hooks";
import type { PersnallyClient } from "../../api/client";
import type { AskRow } from "../../api/types";
import { pct, timeAgo } from "../../lib/format";
import { prettyClient } from "../../lib/provenance";
import { EvidenceWalk } from "./EvidenceWalk";

/** One row of the ledger: who asked, what your model said, how sure it was,
    the evidence, and your verdict on it. */
export function AskEntry({
  client,
  row,
  onJudge,
}: {
  client: PersnallyClient;
  row: AskRow;
  onJudge: (row: AskRow, verdict: "approved" | "vetoed") => void;
}) {
  const [open, setOpen] = useState(false);
  const judged = row.verdict !== null;

  return (
    <div class={`ask-entry${row.deferred ? " deferred" : ""}`}>
      <div class="ask-label">
        <span>
          {prettyClient(row.asker)} asked · {timeAgo(row.ts)}
        </span>
      </div>
      <div class="q">{row.question}</div>
      <div class="a">{row.deferred && !row.answer ? "Sent back to you — no answer was given." : row.answer}</div>
      {row.deferred && <div class="defer-note">Below the confidence bar, so the agent was sent back to ask you directly.</div>}
      <div class="ask-meta">
        {row.deferred ? (
          <span>sent back · {pct(row.confidence)}</span>
        ) : (
          <span class="conf num" title={`confidence ${row.confidence.toFixed(2)}`}>
            <span class="conf-bar">
              <span class={`conf-fill${row.confidence >= 0.7 ? " high" : ""}`} style={`width:${Math.round(row.confidence * 100)}%`} />
            </span>
            {pct(row.confidence)}
          </span>
        )}
        {row.evidence_event_ids.length > 0 && (
          <button class="link-btn" onClick={() => setOpen(!open)}>
            evidence · {row.evidence_event_ids.length}
          </button>
        )}
        {judged && <span class={`tag ${row.verdict === "approved" ? "ok" : "off"}`}>{row.verdict}</span>}
        {!judged && !row.deferred && client.mode === "live" && (
          <>
            <button class="mini" onClick={() => onJudge(row, "approved")}>right</button>
            <button class="mini" onClick={() => onJudge(row, "vetoed")}>wrong</button>
          </>
        )}
      </div>
      {row.evidence_event_ids.length > 0 && <EvidenceWalk client={client} ids={row.evidence_event_ids} open={open} />}
    </div>
  );
}
