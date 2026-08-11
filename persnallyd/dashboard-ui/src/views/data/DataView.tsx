import { useState } from "preact/hooks";
import type { PersnallyClient } from "../../api/client";
import type { EventEnvelope, SearchHit, Skill, StyleSignal, TopicRow, Voice } from "../../api/types";
import type { Boot } from "../../lib/boot-state";
import { timeAgo } from "../../lib/format";
import { num, str } from "../../lib/payload";
import { readSnapshot, saveSnapshot } from "../../lib/snapshot";
import { usePoll } from "../../lib/use-poll";
import { Bar, ConfirmButton, Empty, Flash, Panel } from "../../ui/bits";

/** Data — "what is the model built from?" Every signal, labelled and deletable. */
export function DataView({ client, boot }: { client: PersnallyClient; boot: Boot }) {
  const [topics, setTopics] = useState<TopicRow[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [voice, setVoice] = useState<Voice | null>(null);
  const [assertions, setAssertions] = useState<EventEnvelope[]>([]);
  const [delta, setDelta] = useState<{ risen: TopicRow[]; fresh: TopicRow[]; since: string } | null>(null);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null);

  const load = async () => {
    const [t, s, v, a] = await Promise.all([
      client.topics(40),
      client.skills(25),
      client.voice(),
      client.events({ type: "signal.assertion", limit: 20 }),
    ]);
    setTopics(t);
    setSkills(s);
    setVoice(v);
    setAssertions(a);

    // "Since you last looked" — diffed against the localStorage baseline, then
    // the baseline advances. Same key the classic dashboard uses.
    const snap = readSnapshot();
    if (snap && t.length) {
      const risen = t.filter((x) => (snap.weights[x.topic_key] ?? 0) > 0 && x.weight - (snap.weights[x.topic_key] ?? 0) > 0.05);
      const fresh = t.filter((x) => snap.weights[x.topic_key] === undefined);
      if (risen.length || fresh.length) setDelta({ risen: risen.slice(0, 5), fresh: fresh.slice(0, 5), since: snap.t });
    }
    if (t.length) saveSnapshot(Object.fromEntries(t.map((x) => [x.topic_key, x.weight])));
  };

  usePoll(boot, load);

  async function forgetTopic(t: TopicRow) {
    const r = await client.forgetTopic(t.topic);
    setFlash(r.ok ? { ok: true, text: `Forgot "${t.topic}" and everything derived from it.` } : { ok: false, text: r.error });
    if (r.ok) await load();
  }

  async function forgetStyle(s: StyleSignal) {
    const r = await client.forgetStyle(s.dimension, s.pattern);
    setFlash(r.ok ? { ok: true, text: `Forgot "${s.pattern}" — it won't be re-learned.` } : { ok: false, text: r.error });
    if (r.ok) setVoice(await client.voice());
  }

  async function runSearch(term: string) {
    setQ(term);
    if (term.trim().length < 2) {
      setHits(null);
      return;
    }
    setHits(await client.search(term.trim()));
  }

  const byDimension = new Map<string, StyleSignal[]>();
  for (const it of voice?.items ?? []) {
    const list = byDimension.get(it.dimension) ?? [];
    list.push(it);
    byDimension.set(it.dimension, list);
  }

  return (
    <div class="flow-col">
      <Flash msg={flash} />

      {delta && (
        <Panel title="Since you last looked" sub={`baseline from ${timeAgo(delta.since)}`}>
          {delta.fresh.length > 0 && (
            <p class="body-text">
              New: {delta.fresh.map((t) => t.topic).join(", ")}
            </p>
          )}
          {delta.risen.length > 0 && (
            <p class="body-text">
              Rising: {delta.risen.map((t) => t.topic).join(", ")}
            </p>
          )}
        </Panel>
      )}

      <Panel title="Search" sub="deterministic, offline — no model call">
        <input
          class="field"
          type="search"
          value={q}
          placeholder="Find a topic or assertion…"
          onInput={(e) => void runSearch((e.target as HTMLInputElement).value)}
        />
        {hits !== null && (
          hits.length === 0 ? <Empty>Nothing matched "{q}".</Empty> : (
            <ul class="rows">
              {hits.map((h) => (
                <li key={`${h.kind}-${h.text}`} class="row">
                  <span class="row-main">
                    <span class="tag">{h.kind}</span> {h.text}
                  </span>
                  <span class="row-meta">{h.detail}</span>
                </li>
              ))}
            </ul>
          )
        )}
      </Panel>

      <Panel title="Interests" sub={`${topics.length} topics, decay-weighted — strongest first`}>
        {topics.length === 0 ? (
          <Empty>Nothing imported yet.</Empty>
        ) : (
          <ul class="rows">
            {topics.map((t) => (
              <li key={t.topic_key} class="row">
                <span class="row-main">
                  {t.topic}
                  <span class="row-sub">
                    {t.category} · {t.dominant_intent} · {t.signals} signal{t.signals === 1 ? "" : "s"} · last {timeAgo(t.last_seen)}
                    {t.entities.length > 0 && ` · ${t.entities.slice(0, 4).join(", ")}`}
                  </span>
                </span>
                <span class="row-num num" title={`weight ${t.weight.toFixed(2)}`}>
                  <Bar value={t.weight} max={Math.max(...topics.map((x) => x.weight))} tone={`var(--cat-${t.category}, var(--cat-other))`} />
                  {t.weight.toFixed(2)}
                </span>
                <ConfirmButton
                  label="forget"
                  confirmLabel="forget for good"
                  title="Hard-delete this topic and everything derived from it"
                  onConfirm={() => void forgetTopic(t)}
                />
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="What changed about you" sub="behavioral patterns the nightly reflection derived">
        {assertions.length === 0 ? (
          <Empty>No reflections yet — they arrive with the nightly consolidation.</Empty>
        ) : (
          <ul class="rows">
            {assertions.slice(0, 8).map((e) => {
              const claim = str(e.payload.claim);
              if (!claim) return null;
              return (
                <li key={e.id} class="row">
                  <span class="row-main">
                    {claim}
                    <span class="row-sub">
                      {str(e.payload.kind, "derived")} · {timeAgo(e.ts)}
                    </span>
                  </span>
                  <span class="row-num num">{Math.round(num(e.payload.confidence) * 100)}%</span>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <Panel title="Demonstrated skills" sub="mined from repos you actually commit to, at zero token cost">
        {skills.length === 0 ? (
          <Empty>No skills yet — import a git repo with <code>persnally import git &lt;path&gt;</code>.</Empty>
        ) : (
          <ul class="rows">
            {skills.map((s) => (
              <li key={s.skill} class="row">
                <span class="row-main">
                  {s.skill}
                  <span class="row-sub">
                    {s.domain} · {s.sources} source{s.sources === 1 ? "" : "s"}
                  </span>
                </span>
                <span class="row-num num">
                  <Bar value={s.proficiency} />
                  {s.proficiency.toFixed(2)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="How you write" sub="served to scoped clients too — it's how you write, not what about">
        {!voice?.pack ? (
          <Empty>No style signals yet.</Empty>
        ) : (
          <>
            <p class="body-text">{voice.pack}</p>
            {[...byDimension.entries()].map(([dim, items]) => (
              <div key={dim} class="chip-group">
                <span class="chip-label">{dim}</span>
                {items.map((s) => (
                  <span key={s.pattern} class="chip" title={`${s.polarity} · ${s.basis} · ${s.evidence}`}>
                    {s.pattern}
                    <button class="chip-x" title="Forget this pattern" onClick={() => void forgetStyle(s)}>
                      ×
                    </button>
                  </span>
                ))}
              </div>
            ))}
          </>
        )}
      </Panel>
    </div>
  );
}
