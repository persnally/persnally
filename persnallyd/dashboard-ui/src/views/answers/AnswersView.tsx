import { useRef, useState } from "preact/hooks";
import type { PersnallyClient } from "../../api/client";
import type { AskRow, Questions } from "../../api/types";
import type { Boot } from "../../lib/boot-state";
import { fmtN } from "../../lib/format";
import { usePoll } from "../../lib/use-poll";
import { Empty, Flash } from "../../ui/bits";
import { AskEntry } from "./AskEntry";

/** Answers — the ledger. Every question an AI asked your model instead of
    you, what it answered, and the ones it sent back. The number leads: zero
    this week means the loop is not running, and that has to be visible. */
export function AnswersView({ client, boot }: { client: PersnallyClient; boot: Boot }) {
  const [asks, setAsks] = useState<Questions | null | undefined>(undefined);
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null);
  const generation = useRef(0);

  // A poll tick in flight when a verdict lands would otherwise resolve after
  // the judgment's reload and put the unjudged snapshot back on screen.
  const load = async () => {
    const mine = ++generation.current;
    const q = await client.questions(50);
    if (mine === generation.current) setAsks(q);
  };
  usePoll(boot, load);

  async function judge(a: AskRow, verdict: "approved" | "vetoed") {
    const r = await client.judge(a.answer_id, verdict);
    setFlash(r.ok ? { ok: true, text: verdict === "approved" ? "Marked right." : "Marked wrong — it won't repeat that answer." } : { ok: false, text: r.error });
    if (r.ok) await load();
  }

  const s = asks?.stats;
  const sentBack = s ? s.asked7d - s.answered7d : 0;
  const judged = s ? s.approved + s.edited + s.vetoed : 0;

  return (
    <div class="flow-col">
      <Flash msg={flash} />

      <div class="ledger-stat">
        <span class="ledger-num num">{s ? fmtN(s.answered7d) : "–"}</span>
        <span class="ledger-label">answered for you this week</span>
        <span class="ledger-sub">
          {s
            ? `${fmtN(sentBack)} sent back to you · ${fmtN(s.asked)} asked all-time${
                judged ? ` · ${fmtN(s.approved)} of ${fmtN(judged)} judged marked right` : ""
              }`
            : asks === null
              ? "unavailable"
              : "loading…"}
        </span>
      </div>

      {asks === null && <Empty>Couldn't read the ledger — is the daemon running?</Empty>}
      {asks && asks.items.length === 0 && (
        <Empty>
          Nothing asked yet. This is the ledger: every question an AI asks your model instead of you lands
          here, with its answer, the evidence and your verdict. A connected AI calls <code>persnally_ask</code>{" "}
          before interrupting you — run <code>persnally connect --all</code>, then start a session.
        </Empty>
      )}
      {asks?.items.map((a) => (
        <AskEntry key={a.answer_id} client={client} row={a} onJudge={judge} />
      ))}
    </div>
  );
}
