import { useState } from "preact/hooks";
import type { PersnallyClient } from "../../api/client";
import type { Profile } from "../../api/types";
import { EvidenceWalk } from "./EvidenceWalk";

export function Portrait({ client, profile }: { client: PersnallyClient; profile: Profile }) {
  const [openEvidence, setOpenEvidence] = useState<number | null>(null);

  return (
    <>
      <div class="reveal">
        <h1 class="headline">{profile.headline}</h1>
        <div class="byline">
          synthesized {profile.generated_at.slice(0, 10)} · {profile.model} · structured events only
        </div>
      </div>
      {profile.sections.map((s, i) => (
        <div key={s.title} class="card reveal">
          <h2 class="sect">{s.title}</h2>
          <p class="body-text">{s.body}</p>
          {s.evidence_event_ids.length > 0 && (
            <>
              <button class="link-btn" style="margin-top:8px" onClick={() => setOpenEvidence(openEvidence === i ? null : i)}>
                why? · {s.evidence_event_ids.length}
              </button>
              <EvidenceWalk client={client} ids={s.evidence_event_ids} open={openEvidence === i} />
            </>
          )}
        </div>
      ))}
    </>
  );
}
