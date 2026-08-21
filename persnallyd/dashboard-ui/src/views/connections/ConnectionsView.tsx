import { useEffect, useRef, useState } from "preact/hooks";
import type { PersnallyClient } from "../../api/client";
import type { EngineStatus, EventEnvelope, Mutation, Scopes, Stats } from "../../api/types";
import type { Boot } from "../../lib/boot-state";
import { fmtN, timeAgo } from "../../lib/format";
import { importedText } from "../../lib/import-result";
import { num, str } from "../../lib/payload";
import { prettyClient } from "../../lib/provenance";
import { usePoll } from "../../lib/use-poll";
import { Bar, Flash, Panel } from "../../ui/bits";
import { BrandMark } from "../../ui/BrandMark";

/** The eight clients `persnally connect --all` covers. ChatGPT is absent by
    design: its connectors need a public HTTPS endpoint; the daemon is loopback. */
const CLIENTS = [
  "claude-code", "claude-desktop", "cursor", "codex-cli", "gemini-cli", "windsurf", "zed", "vscode",
];

/** Keyed by `payload.importer` — a system.import event's own `source` is
    "system", so keying on source silently reports everything as un-imported. */
const IMPORTERS: Record<string, string> = {
  claude: "Claude export",
  chatgpt: "ChatGPT export",
  "claude-code": "Claude Code sessions",
  git: "git repositories",
};

/** Connections — "what feeds it?" The engine, the importers, and the clients. */
export function ConnectionsView({ client, boot }: { client: PersnallyClient; boot: Boot }) {
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [scopes, setScopes] = useState<Scopes>({});
  const [imports, setImports] = useState<EventEnvelope[]>([]);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null);
  const pollingPull = useRef(false);

  const load = async () => {
    const [e, s, sc, im] = await Promise.all([
      client.engine(),
      client.stats(),
      client.scopes(),
      client.events({ type: "system.import", limit: 500 }),
    ]);
    setEngine(e);
    setStats(s);
    setScopes(sc ?? {});
    setImports(im);
  };

  usePoll(boot, load);

  // While a model is downloading, follow it closely rather than on the 25s tick.
  useEffect(() => {
    if (engine?.pull.state !== "pulling" || pollingPull.current) return;
    pollingPull.current = true;
    let misses = 0;
    const id = setInterval(async () => {
      const p = await client.pullStatus();
      // A daemon that stopped answering can't still be downloading; give up
      // rather than render "downloading" and poll forever.
      if (!p) {
        if (++misses < 5) return;
        clearInterval(id);
        pollingPull.current = false;
        setEngine((prev) => (prev ? { ...prev, pull: { ...prev.pull, state: "error", error: "lost contact with the daemon during the download" } } : prev));
        return;
      }
      misses = 0;
      setEngine((prev) => (prev ? { ...prev, pull: p } : prev));
      if (p.state !== "pulling") {
        clearInterval(id);
        pollingPull.current = false;
        await load();
      }
    }, 1500);
    return () => {
      clearInterval(id);
      pollingPull.current = false;
    };
  }, [engine?.pull.state]);

  async function act<T>(name: string, run: () => Promise<Mutation<T>>, okText: string | ((data: T) => string)) {
    setBusy(name);
    const r = await run();
    setBusy(null);
    setFlash(r.ok
      ? { ok: true, text: typeof okText === "function" ? okText(r.data) : okText }
      : { ok: false, text: r.error ?? "Failed." });
    if (r.ok) await load();
  }



  const engineLabel = !engine
    ? "unavailable"
    : engine.hasKey
      ? `Claude API · key ${engine.keyMasked}`
      : engine.models.extract
        ? `local via Ollama · ${engine.models.extract} — nothing leaves this machine`
        : "not configured";

  const byImporter = new Map<string, { events: number; last: string }>();
  for (const e of imports) {
    const name = str(e.payload.importer);
    if (!name) continue;
    const prev = byImporter.get(name);
    byImporter.set(name, {
      events: (prev?.events ?? 0) + num(e.payload.events),
      last: prev?.last && prev.last > e.ts ? prev.last : e.ts,
    });
  }

  return (
    <div class="flow-col">
      <Flash msg={flash} />

      <Panel title="Extraction engine" sub={engineLabel}>
        {engine?.lastFailure && (
          <p class="flash bad">
            The engine is failing: {engine.lastFailure.message} ({engine.lastFailure.count} call
            {engine.lastFailure.count === 1 ? "" : "s"} in a row, last {timeAgo(engine.lastFailure.at)}).
            Nothing new is being extracted until this clears.
          </p>
        )}
        {engine && !engine.hasKey && !engine.ollama.hasModel && (
          <p class="body-text">
            Nothing can be extracted until one of these is set up. Git history and writing style import fully offline.
          </p>
        )}
        <div class="stack-form">
          <label class="field-row">
            <input
              class="field"
              type="password"
              value={key}
              placeholder="sk-ant-… (stored in your mode-0600 config)"
              onInput={(e) => setKey((e.target as HTMLInputElement).value)}
            />
            <button
              class="btn"
              disabled={!key.startsWith("sk-ant-") || busy !== null}
              onClick={() => void act("key", () => client.saveKey(key).then((r) => { if (r.ok) setKey(""); return r; }), "Key saved — extraction is live, no restart needed.")}
            >
              {busy === "key" ? "saving…" : "Save key"}
            </button>
          </label>

          {engine?.ollama.reachable ? (
            engine.pull.state === "pulling" ? (
              <div>
                <p class="body-text">
                  Downloading {engine.pull.model} — {engine.pull.status} {engine.pull.percent}%
                </p>
                <Bar value={engine.pull.percent} max={100} tone="var(--active)" />
              </div>
            ) : (
              <span class="field-row">
                <span class="body-text">
                  Ollama is running{engine.ollama.hasModel ? ` with ${engine.ollama.models.join(", ")}` : " but has no model"}.
                </span>
                {!engine.ollama.hasModel && (
                  <button class="btn" disabled={busy !== null} onClick={() => void act("pull", () => client.pullModel(engine.recommended), `Pulling ${engine.recommended}…`)}>
                    Download {engine.recommended} (~2GB)
                  </button>
                )}
              </span>
            )
          ) : (
            <p class="body-text">
              For a fully local engine, install Ollama from <code>ollama.com/download</code>, then reload this page.
            </p>
          )}
          {engine?.pull.state === "error" && <p class="flash bad">{engine.pull.error}</p>}
        </div>
      </Panel>

      <Panel
        title="Sources"
        sub="import is how the model starts — organic capture measured 3%, so this is the path that matters"
        action={
          <button
            class="btn"
            disabled={busy !== null}
            onClick={() => void act("import", () => client.importAll(), (r) => `${importedText(r)} Re-synthesize on Control to fold it into the portrait.`)}
          >
            {busy === "import" ? "importing…" : "Import everything"}
          </button>
        }
      >
        <ul class="rows">
          {Object.entries(IMPORTERS).map(([name, label]) => {
            const hit = byImporter.get(name);
            return (
              <li key={name} class="row">
                <BrandMark name={name} />
                <span class="row-main">
                  {label}
                  <span class="row-sub">
                    {hit ? `${fmtN(hit.events)} events · last ${timeAgo(hit.last)}` : "not imported yet"}
                  </span>
                </span>
                <span class={`tag ${hit ? "ok" : ""}`}>{hit ? "imported" : "idle"}</span>
              </li>
            );
          })}
        </ul>
        {stats && (
          <p class="panel-note">
            {fmtN(stats.total)} events on file{stats.first ? ` · first ${stats.first.slice(0, 10)}` : ""}
          </p>
        )}
      </Panel>

      <Panel title="AI clients" sub="each reads your context over MCP; ChatGPT can't (its connectors need a public endpoint — your history still imports)">
        {/* Activity is the only thing observable here — whether a token was ever
            issued isn't exposed over HTTP (it shouldn't be), so this reports
            what each client has actually done rather than claiming a state it
            can't verify. */}
        <ul class="rows">
          {CLIENTS.map((c) => {
            // Both channels count: an MCP tool call and a session-start hook
            // injection are the same client consuming context.
            const events = (stats?.bySource?.[`mcp:${c}`] ?? 0) + (stats?.bySource?.[`hook:${c}`] ?? 0);
            const grant = scopes[c];
            const revoked = grant?.length === 0;
            return (
              <li key={c} class="row">
                <BrandMark name={c} />
                <span class="row-main">
                  {prettyClient(c)}
                  <span class="row-sub">
                    {revoked
                      ? `revoked — reads nothing${events > 0 ? ` (${fmtN(events)} written before that)` : ""}`
                      : events > 0
                        ? `${fmtN(events)} event${events === 1 ? "" : "s"} written, all-time`
                        : grant
                          ? `limited to ${grant.join(", ")} — no activity yet`
                          : `no activity yet — run persnally connect ${c}, then restart it`}
                  </span>
                </span>
                <span class={`tag ${revoked ? "" : events > 0 ? "ok" : ""}`}>
                  {revoked ? "revoked" : events > 0 ? "used" : "idle"}
                </span>
              </li>
            );
          })}
        </ul>
        <p class="panel-note">
          <code>persnally connect --all</code> covers every client you have installed, then restart it.
        </p>
      </Panel>
    </div>
  );
}
