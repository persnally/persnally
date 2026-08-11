import { useEffect, useRef, useState } from "preact/hooks";
import type { PersnallyClient } from "../../api/client";
import type { AskResult, AskRow, Profile } from "../../api/types";
import type { Boot } from "../../lib/boot-state";
import { timeAgo } from "../../lib/format";
import { prettyClient } from "../../lib/provenance";
import { usePoll } from "../../lib/use-poll";
import { Mark } from "../../shell/Mark";
import { AskComposer } from "./AskComposer";
import { AskEntry } from "./AskEntry";
import { Portrait } from "./Portrait";

/**
 * Mirror — "what does it know about me?" The portrait scrolls; the composer is
 * docked beneath it, and each answer appends to the flow so a question and what
 * your model said read as one continuing thread. Opening a past ask from the
 * rail drops it into the same thread.
 */
export function MirrorView({
  client,
  boot,
  model,
  focusSignal,
  onAsked,
  opened,
  onClearOpened,
}: {
  client: PersnallyClient;
  boot: Boot;
  model: string;
  focusSignal: number;
  onAsked: () => void;
  opened: AskRow | null;
  onClearOpened: () => void;
}) {
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined);
  const [entries, setEntries] = useState<{ question: string; result: AskResult }[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [coolingUntil, setCoolingUntil] = useState(0);
  const flow = useRef<HTMLDivElement>(null);

  usePoll(boot, async () => {
    setProfile(await client.profile());
  });

  // Newest answer is at the bottom of the flow — follow it, like a thread.
  // Deferred a frame: on the commit that adds an entry, scrollHeight hasn't
  // grown yet, so scrolling here lands short of the answer just asked for.
  useEffect(() => {
    if (!entries.length && !opened) return;
    const el = flow.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [entries.length, opened?.answer_id]);

  async function ask(question: string) {
    setBusy(true);
    setNotice(null);
    setError(null);
    const r = await client.ask(question);
    setBusy(false);
    if (r.kind === "ok") {
      setEntries((prev) => [...prev, { question, result: r.result }]);
      onAsked();
    } else if (r.kind === "rate-limited") {
      setNotice(r.message);
      setCoolingUntil(Date.now() + 60_000);
      setTimeout(() => setCoolingUntil(0), 60_000);
    } else {
      setError(r.message);
    }
  }

  const bare = profile === null && entries.length === 0 && !opened;

  return (
    <div class={`canvas${bare ? " empty-state" : ""}`}>
      <div class="flow" ref={flow}>
        <div class="flow-col">
          {profile === undefined && <div class="empty">loading…</div>}
          {bare && (
            <div class="greeting reveal">
              <Mark class="mark" />
              <h1>No portrait yet</h1>
              <p>
                Import your AI history with <code>persnally setup</code>, then synthesize. You can still ask below — it
                answers from whatever evidence is already on file.
              </p>
            </div>
          )}
          {profile && <Portrait client={client} profile={profile} />}

          {opened && (
            <AskEntry
              client={client}
              question={opened.question}
              result={{
                question_id: opened.question_id,
                answer_id: opened.answer_id,
                answer: opened.answer,
                confidence: opened.confidence,
                deferred: opened.deferred,
                evidence_event_ids: opened.evidence_event_ids,
              }}
              label={`asked by ${prettyClient(opened.asker)} · ${timeAgo(opened.ts)}${opened.verdict ? ` · you marked it ${opened.verdict}` : ""}`}
              onClose={onClearOpened}
            />
          )}

          {entries.map((e) => (
            <AskEntry key={e.result.answer_id} client={client} question={e.question} result={e.result} />
          ))}
        </div>
      </div>

      <div class="dock">
        <div class="dock-col">
          <AskComposer
            onSubmit={(q) => void ask(q)}
            busy={busy}
            cooling={Date.now() < coolingUntil}
            model={model}
            demo={client.mode === "demo"}
            focusSignal={focusSignal}
          />
          {notice && <div class="notice">{notice}</div>}
          {error && <div class="error-text">{error}</div>}
          {!notice && !error && (
            <div class="disclaimer">Answered from your own history — every answer cites its evidence.</div>
          )}
        </div>
      </div>
    </div>
  );
}
