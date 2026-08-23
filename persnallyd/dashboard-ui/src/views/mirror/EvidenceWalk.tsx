import { useEffect, useState } from "preact/hooks";
import type { PersnallyClient } from "../../api/client";
import type { EventEnvelope } from "../../api/types";
import { eventSummary, provLabel } from "../../lib/provenance";

/**
 * The "why does it think this?" panel — resolves evidence ids to the actual
 * events. Lazy: fetches on first expand, then caches. An empty resolve is
 * rendered honestly (the event was deleted); ids are pre-validated server-side.
 */
export function EvidenceWalk({ client, ids, open }: { client: PersnallyClient; ids: string[]; open: boolean }) {
  const [rows, setRows] = useState<EventEnvelope[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || rows !== null || loading) return;
    setLoading(true);
    void client.events({ ids }).then((evs) => {
      setRows(evs);
      setLoading(false);
    });
    // deps: fetch once on first open; ids are stable for a given section/answer
  }, [open]);

  return (
    <div class={`evidence${open ? " open" : ""}`}>
      {loading && <div class="evidence-row">loading evidence…</div>}
      {rows !== null && rows.length === 0 && <div class="evidence-row">evidence not found (deleted?)</div>}
      {rows?.map((e) => (
        <div key={e.id} class="evidence-row">
          <code>{e.type}</code>
          <span>{eventSummary(e)}</span>
          <i>
            — {provLabel(e)}, {e.ts.slice(0, 10)}
          </i>
        </div>
      ))}
    </div>
  );
}
