import { useState } from "preact/hooks";
import type { PersnallyClient } from "../../api/client";
import type { EngineStatus, Profile, Stats } from "../../api/types";
import type { Boot } from "../../lib/boot-state";
import { fmtN, timeAgo } from "../../lib/format";
import { usePoll } from "../../lib/use-poll";
import { Empty, Flash, Panel } from "../../ui/bits";

/** Control — "who's in charge here?" Owner actions, and an honest account of
    the ones the daemon deliberately does not expose over HTTP. */
export function ControlView({ client, boot }: { client: PersnallyClient; boot: Boot }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null);

  const load = async () => {
    const [p, s, e] = await Promise.all([client.profile(), client.stats(), client.engine()]);
    if (p !== undefined) setProfile(p); // undefined = couldn't tell, keep what we had
    setStats(s);
    setEngine(e);
  };

  usePoll(boot, load);

  async function act(name: string, run: () => Promise<{ ok: boolean; error?: string }>, okText: (d: unknown) => string) {
    setBusy(name);
    const r = await run();
    setBusy(null);
    setFlash(r.ok ? { ok: true, text: okText((r as { data?: unknown }).data) } : { ok: false, text: r.error ?? "Failed." });
    if (r.ok) await load();
  }

  return (
    <div class="flow-col">
      <Flash msg={flash} />

      <Panel
        title="The portrait"
        sub={profile ? `synthesized ${timeAgo(profile.generated_at)} · ${profile.model} · ${profile.sections.length} sections` : "not synthesized yet"}
        action={
          <button
            class="btn"
            disabled={busy !== null}
            onClick={() =>
              void act("synth", () => client.synthesize(), (d) => {
                const p = d as Profile | undefined;
                return p ? `Re-synthesized — ${p.sections.length} sections from ${p.model}.` : "Re-synthesized.";
              })
            }
          >
            {busy === "synth" ? "synthesizing…" : "Re-synthesize"}
          </button>
        }
      >
        <p class="body-text">
          Rebuilds the portrait from everything currently on file. Runs on your profile model; the nightly consolidation
          does it automatically when enough new signal has landed.
        </p>
      </Panel>

      <Panel
        title="Reflection"
        sub="derives behavioral patterns from recent signals, then refreshes the portrait"
        action={
          <button
            class="btn"
            disabled={busy !== null}
            onClick={() =>
              void act("reflect", () => client.consolidate(), (d) => {
                const r = d as { newSignals?: number; assertions?: number; profileRefreshed?: boolean } | undefined;
                return r
                  ? `${r.newSignals ?? 0} new signals · ${r.assertions ?? 0} assertions · portrait ${r.profileRefreshed ? "refreshed" : "kept"}.`
                  : "Reflection complete.";
              })
            }
          >
            {busy === "reflect" ? "reflecting…" : "Reflect now"}
          </button>
        }
      >
        <p class="body-text">Normally runs once a day at 3am local. Running it by hand costs one extraction call.</p>
      </Panel>

      <Panel title="Models" sub="which model runs which job">
        <ul class="rows">
          <li class="row">
            <span class="row-main">
              Extraction
              <span class="row-sub">every imported conversation, every ask — the high-volume path</span>
            </span>
            <span class="row-meta">{engine?.models.extract ?? "not configured"}</span>
          </li>
          <li class="row">
            <span class="row-main">
              Portrait synthesis
              <span class="row-sub">
                once nightly, plus whenever you re-synthesize
                {profile?.model ? ` · the one you have was built by ${profile.model}` : ""}
              </span>
            </span>
            <span class="row-meta">{engine?.models.profile ?? "not configured"}</span>
          </li>
        </ul>
        <p class="panel-note">
          Override either with <code>PERSNALLY_MODEL</code> / <code>PERSNALLY_PROFILE_MODEL</code> in the daemon's
          environment. On macOS the daemon runs under launchd, so a shell export won't reach it — set them in
          <code>~/Library/LaunchAgents/com.persnally.daemon.plist</code> and reload the agent.
        </p>
      </Panel>

      <Panel title="Your data" sub={stats ? `${fmtN(stats.total)} events · one SQLite file on this machine` : undefined}>
        {!stats ? (
          <Empty>Stats unavailable.</Empty>
        ) : (
          <ul class="rows">
            {Object.entries(stats.byType)
              .sort((a, b) => b[1] - a[1])
              .map(([type, n]) => (
                <li key={type} class="row">
                  <span class="row-main">
                    <code>{type}</code>
                  </span>
                  <span class="row-num num">{fmtN(n)}</span>
                </li>
              ))}
          </ul>
        )}
        <p class="panel-note">
          Take it with you or destroy it from the terminal — these stay off the HTTP surface on purpose, so nothing
          reachable over a port can export or wipe your model:
        </p>
        <ul class="cmds">
          <li><code>persnally export</code> — everything, re-importable JSON</li>
          <li><code>persnally export --md</code> — a readable portrait</li>
          <li><code>persnally forget --all</code> — delete everything, irreversibly</li>
          <li><code>persnally dashboard --rotate</code> — invalidate every dashboard session</li>
        </ul>
      </Panel>
    </div>
  );
}
