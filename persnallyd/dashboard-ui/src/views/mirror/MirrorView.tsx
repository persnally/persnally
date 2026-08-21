import { useEffect, useRef, useState } from "preact/hooks";
import type { PersnallyClient } from "../../api/client";
import type { AskResult, AskRow, Mutation, Profile } from "../../api/types";
import type { Boot } from "../../lib/boot-state";
import { timeAgo } from "../../lib/format";
import { prettyClient } from "../../lib/provenance";
import { usePoll } from "../../lib/use-poll";
import { Mark } from "../../shell/Mark";
import { AskComposer } from "./AskComposer";
import { AskEntry } from "./AskEntry";
import { Portrait } from "./Portrait";
import { importedText } from "../../lib/import-result";

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
  const [total, setTotal] = useState<number | null>(null);
  const [setupBusy, setSetupBusy] = useState<string | null>(null);
  const [setupNote, setSetupNote] = useState<{ ok: boolean; text: string } | null>(null);
  const flow = useRef<HTMLDivElement>(null);

  usePoll(boot, async () => {
    setTotal((await client.stats())?.total ?? null);
    const p = await client.profile();
    // undefined means the fetch failed, not that the portrait is gone —
    // replacing a rendered portrait with "no portrait yet" on a blip would be
    // the dashboard lying about the store.
    if (p !== undefined) setProfile(p);
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
  // An empty store and a store awaiting synthesis are different products to
  // render. On the first there is nothing to ask about — the composer could
  // only defer — so the import that actually starts the model leads instead.
  const fresh = bare && total === 0;

  async function runSetup<T>(name: string, run: () => Promise<Mutation<T>>, okText: (data: T) => string) {
    setSetupBusy(name);
    const r = await run();
    setSetupBusy(null);
    setSetupNote(r.ok ? { ok: true, text: okText(r.data) } : { ok: false, text: r.error });
    if (r.ok) {
      setTotal((await client.stats())?.total ?? null);
      const p = await client.profile();
      if (p !== undefined) setProfile(p);
    }
  }

  return (
    <div class={`canvas${bare ? " empty-state" : ""}${fresh ? " no-dock" : ""}`}>
      <div class="flow" ref={flow}>
        <div class="flow-col">
          {profile === undefined && <div class="empty">loading…</div>}
          {bare && (
            <div class="greeting reveal">
              <Mark class="mark" />
              <h1>{fresh ? "Nothing imported yet" : "No portrait yet"}</h1>
              <p>
                {fresh
                  ? "Persnally builds a model of you from AI history you already have. Import reads Claude and ChatGPT exports in ~/Downloads and your Claude Code sessions — nothing leaves this machine."
                  : `${total ?? 0} events on file. Synthesize to turn them into a portrait, or ask below — it answers from whatever evidence is already there.`}
              </p>
              <div class="greeting-actions">
                {fresh ? (
                  <button
                    class="btn primary"
                    disabled={setupBusy !== null || client.mode === "demo"}
                    onClick={() => void runSetup("import", () => client.importAll(), importedText)}
                  >
                    {setupBusy === "import" ? "importing…" : "Import your AI history"}
                  </button>
                ) : (
                  <button
                    class="btn primary"
                    disabled={setupBusy !== null || client.mode === "demo"}
                    onClick={() => void runSetup("synth", () => client.synthesize(), (p) => `Portrait synthesized — ${p.sections.length} sections from ${p.model}.`)}
                  >
                    {setupBusy === "synth" ? "synthesizing…" : "Synthesize the portrait"}
                  </button>
                )}
              </div>
              {setupNote && <p class={`flash ${setupNote.ok ? "" : "bad"}`}>{setupNote.text}</p>}
            </div>
          )}
          {profile && <Portrait client={client} profile={profile} />}

          {opened && !entries.some((e) => e.result.answer_id === opened.answer_id) && (
            <AskEntry
              // Keyed: without it Preact reuses one instance across different
              // asks, and the cached evidence of the last one renders here.
              key={opened.answer_id}
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

      {!fresh && (
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
      )}
    </div>
  );
}
