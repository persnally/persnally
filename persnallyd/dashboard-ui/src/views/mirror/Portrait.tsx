import { useState } from "preact/hooks";
import type { PersnallyClient } from "../../api/client";
import type { Profile } from "../../api/types";
import { EvidenceWalk } from "./EvidenceWalk";

/** The portrait as editorial prose — no card chrome, hairline-separated
    sections, each expandable to the events it rests on. */
export function Portrait({ client, profile }: { client: PersnallyClient; profile: Profile }) {
  const [openEvidence, setOpenEvidence] = useState<string | null>(null);

  return (
    <>
      <div class="portrait-head reveal">
        <h1>{profile.headline}</h1>
        <div class="byline">
          synthesized {profile.generated_at.slice(0, 10)} · {profile.model} · structured events only
        </div>
      </div>
      {profile.sections.map((s) => (
        <div key={s.title} class="section reveal">
          <h2>{s.title}</h2>
          <p>{s.body}</p>
          {s.evidence_event_ids.length > 0 && (
            <>
              <button class="link-btn" style="margin-top:9px" onClick={() => setOpenEvidence(openEvidence === s.title ? null : s.title)}>
                why? · {s.evidence_event_ids.length}
              </button>
              {/* Keyed by the ids it fetched: a re-synthesis changes sections,
                  and an index would carry stale rows onto a new section. */}
              <EvidenceWalk key={s.evidence_event_ids.join(",")} client={client} ids={s.evidence_event_ids} open={openEvidence === s.title} />
            </>
          )}
        </div>
      ))}
    </>
  );
}
