import { useState } from "preact/hooks";
import type { PersnallyClient } from "../../api/client";
import type { Mutation, Profile } from "../../api/types";
import type { Boot } from "../../lib/boot-state";
import { usePoll } from "../../lib/use-poll";
import { Mark } from "../../shell/Mark";
import { Portrait } from "./Portrait";
import { importedText } from "../../lib/import-result";

/** Mirror — "what does it know about me?" The portrait, with receipts. */
export function MirrorView({ client, boot }: { client: PersnallyClient; boot: Boot }) {
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined);
  const [total, setTotal] = useState<number | null>(null);
  const [setupBusy, setSetupBusy] = useState<string | null>(null);
  const [setupNote, setSetupNote] = useState<{ ok: boolean; text: string } | null>(null);

  usePoll(boot, async () => {
    setTotal((await client.stats())?.total ?? null);
    const p = await client.profile();
    // undefined means the fetch failed, not that the portrait is gone —
    // replacing a rendered portrait with "no portrait yet" on a blip would be
    // the dashboard lying about the store.
    if (p !== undefined) setProfile(p);
  });

  const bare = profile === null;
  // An empty store and a store awaiting synthesis are different products to
  // render: the first needs an import before anything can be synthesized.
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
    <div class={`canvas${bare ? " empty-state" : ""}`}>
      <div class="flow">
        <div class="flow-col">
          {profile === undefined && <div class="empty">loading…</div>}
          {bare && (
            <div class="greeting reveal">
              <Mark class="mark" />
              <h1>{fresh ? "Nothing imported yet" : "No portrait yet"}</h1>
              <p>
                {fresh
                  ? "Persnally builds a model of you from AI history you already have. Import reads Claude and ChatGPT exports in ~/Downloads and your Claude Code sessions — nothing leaves this machine."
                  : `${total ?? 0} events on file. Synthesize to turn them into a portrait.`}
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
        </div>
      </div>
    </div>
  );
}
