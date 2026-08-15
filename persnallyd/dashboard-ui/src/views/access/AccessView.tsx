import { useState } from "preact/hooks";
import type { PersnallyClient } from "../../api/client";
import { CATEGORIES, type Activity, type AskRow, type Category, type EventEnvelope, type Questions, type Scopes } from "../../api/types";
import type { Boot } from "../../lib/boot-state";
import { timeAgo } from "../../lib/format";
import { list, num, str } from "../../lib/payload";
import { clientOf, prettyClient } from "../../lib/provenance";
import { usePoll } from "../../lib/use-poll";
import { Bar, ConfirmButton, Empty, Flash, Panel } from "../../ui/bits";
import { BrandMark } from "../../ui/BrandMark";

/** Access — "who reads it, and what?" The authority surface: grants, the read
    audit trail, and every question your AIs asked. */
export function AccessView({ client, boot }: { client: PersnallyClient; boot: Boot }) {
  const [scopes, setScopes] = useState<Scopes>({});
  const [reads, setReads] = useState<EventEnvelope[]>([]);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [asks, setAsks] = useState<Questions | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null);

  const load = async () => {
    const [sc, rd, ac, qs] = await Promise.all([
      client.scopes(),
      client.events({ type: "context.read", limit: 60 }),
      client.activity(),
      client.questions(30),
    ]);
    setScopes(sc ?? {});
    setReads(rd);
    setActivity(ac);
    setAsks(qs);
  };

  usePoll(boot, load);

  // Third-party AI clients: those with a grant on file, plus any that has read
  // over MCP. A client that read but has no grant reads *everything*, and hiding
  // that would be the opposite of an access surface. Reads attributed to `cli`
  // or `dashboard` are your own tools, not a client with a grant — they show in
  // the read log below rather than pretending to be a grantee here.
  const seen = new Set<string>([
    ...Object.keys(scopes),
    ...reads.filter((e) => e.source.startsWith("mcp:")).map(clientOf),
  ]);
  const clients = [...seen].filter(Boolean).sort();
  const localReads = reads.filter((e) => !e.source.startsWith("mcp:")).length;

  const state = (c: string): { label: string; tone: string } => {
    const s = scopes[c];
    if (s === undefined) return { label: "reads everything", tone: "warn" };
    if (s.length === 0) return { label: "revoked — reads nothing", tone: "off" };
    return { label: `limited: ${s.join(", ")}`, tone: "ok" };
  };

  async function apply(c: string, categories: Category[]) {
    const r = categories.length === 0 ? await client.setScope(c, []) : await client.setScope(c, categories);
    setFlash(r.ok ? { ok: true, text: `Updated what ${prettyClient(c)} can read.` } : { ok: false, text: r.error });
    if (r.ok) await load();
  }

  async function restore(c: string) {
    const r = await client.clearScope(c);
    setFlash(r.ok ? { ok: true, text: `${prettyClient(c)} reads everything again.` } : { ok: false, text: r.error });
    if (r.ok) await load();
  }

  async function judge(a: AskRow, verdict: "approved" | "vetoed") {
    const r = await client.judge(a.answer_id, verdict);
    setFlash(r.ok ? { ok: true, text: verdict === "approved" ? "Marked right." : "Marked wrong — it won't repeat that answer." } : { ok: false, text: r.error });
    if (r.ok) setAsks(await client.questions(30));
  }

  const maxDaily = Math.max(1, ...(activity?.daily ?? []).map((d) => d.reads));

  return (
    <div class="flow-col">
      <Flash msg={flash} />

      <Panel title="What each AI can read" sub="a grant you can narrow to categories, or revoke outright">
        {clients.length === 0 ? (
          <Empty>
            No AI client holds a grant yet
            {localReads > 0 && ` — the ${localReads} read${localReads === 1 ? "" : "s"} below came from your own CLI and hook, not a connected client`}
            . Run <code>persnally connect --all</code>, then restart the client.
          </Empty>
        ) : (
          <ul class="rows">
            {clients.map((c) => {
              const st = state(c);
              const current = scopes[c] ?? [];
              return (
                <li key={c} class="row col">
                  <span class="row-line">
                    <BrandMark name={c} />
                    <span class="row-main">
                      {prettyClient(c)}
                      <span class={`row-sub ${st.tone}`}>{st.label}</span>
                    </span>
                    <button class="mini" onClick={() => setEditing(editing === c ? null : c)}>
                      {editing === c ? "done" : "change"}
                    </button>
                    {scopes[c] !== undefined && (
                      <button class="mini" onClick={() => void restore(c)} title="Clear the grant — reads everything">
                        restore
                      </button>
                    )}
                    {scopes[c]?.length !== 0 && (
                      <ConfirmButton
                        label="revoke"
                        confirmLabel="revoke all reads"
                        title="This client will read nothing"
                        onConfirm={() => void apply(c, [])}
                      />
                    )}
                  </span>
                  {editing === c && (
                    <span class="cats">
                      {CATEGORIES.map((cat) => {
                        const on = current.includes(cat);
                        return (
                          <button
                            key={cat}
                            class={`cat${on ? " on" : ""}`}
                            onClick={() => void apply(c, on ? current.filter((x) => x !== cat) : [...current, cat])}
                          >
                            {cat}
                          </button>
                        );
                      })}
                      <span class="cats-note">
                        Style is served to a limited client by design — it's how you write, not what about.
                      </span>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <Panel
        title="What your AIs read about you"
        sub={activity ? `${activity.totalReads} reads all-time · ${activity.reads7d} in the last 7 days · ${activity.activeDays7d}/7 active days` : undefined}
      >
        {activity && (
          <div class="spark" title="context reads per day, last 14 days">
            {activity.daily.map((d) => (
              <span key={d.date} class="spark-bar" style={`height:${Math.max(3, (d.reads / maxDaily) * 100)}%`} title={`${d.date}: ${d.reads}`} />
            ))}
          </div>
        )}
        {reads.length === 0 ? (
          <Empty>No reads recorded yet.</Empty>
        ) : (
          <ul class="rows">
            {reads.slice(0, 12).map((e) => {
              const local = !e.source.startsWith("mcp:");
              const purpose = str(e.payload.client_purpose) || str(e.payload.purpose) || "context";
              const items = num(e.payload.items);
              const scope = list(e.payload.scope).join(", ");
              return (
                <li key={e.id} class="row">
                  <span class="row-main">
                    {local ? `you · ${prettyClient(clientOf(e))}` : prettyClient(clientOf(e))}
                    <span class="row-sub">
                      {purpose}
                      {items > 0 && ` · ${items} items`}
                      {scope && ` · ${scope}`}
                    </span>
                  </span>
                  <span class="row-meta">{timeAgo(e.ts)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <Panel
        title="What your AIs asked"
        sub={
          asks
            ? `${asks.stats.asked} asked · ${asks.stats.answered} answered · ${asks.stats.deferred} deferred${
                asks.stats.precision !== null ? ` · ${Math.round(asks.stats.precision * 100)}% precision` : ""
              }`
            : undefined
        }
      >
        {!asks || asks.items.length === 0 ? (
          <Empty>Nothing asked yet. Connected AIs call <code>persnally_ask</code> before interrupting you.</Empty>
        ) : (
          <ul class="rows">
            {asks.items.map((a) => (
              <li key={a.answer_id} class="row col">
                <span class="row-main">
                  {a.question}
                  <span class="row-sub">
                    {prettyClient(a.asker)} · {timeAgo(a.ts)}
                    {a.deferred ? " · deferred to you" : ` · ${Math.round(a.confidence * 100)}% confident`}
                  </span>
                </span>
                {!a.deferred && <span class="row-answer">{a.answer}</span>}
                <span class="row-line">
                  {!a.deferred && <Bar value={a.confidence} tone={a.confidence >= 0.7 ? "var(--active)" : undefined} />}
                  {a.verdict ? (
                    <span class={`tag ${a.verdict === "approved" ? "ok" : "off"}`}>{a.verdict}</span>
                  ) : (
                    !a.deferred && (
                      <>
                        <button class="mini" onClick={() => void judge(a, "approved")}>
                          right
                        </button>
                        <button class="mini" onClick={() => void judge(a, "vetoed")}>
                          wrong
                        </button>
                      </>
                    )
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
