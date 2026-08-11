import { useState } from "preact/hooks";
import type { PersnallyClient } from "./api/client";
import type { AskRow } from "./api/types";
import type { Boot } from "./lib/boot-state";
import { usePoll } from "./lib/use-poll";
import { AREAS_META } from "./shell/areas";
import { Rail } from "./shell/Rail";
import { StubView } from "./shell/StubView";
import { useHashRoute } from "./lib/use-hash-route";
import { MirrorView } from "./views/mirror/MirrorView";

const RAIL_KEY = "persnally.ui.rail";

export function App({ client, boot }: { client: PersnallyClient; boot: Boot }) {
  const area = useHashRoute();
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(RAIL_KEY) === "collapsed";
    } catch {
      return false; // storage blocked — default open, don't crash the first render
    }
  });
  const [up, setUp] = useState(false);
  const [version, setVersion] = useState("");
  const [engine, setEngine] = useState("");
  const [recents, setRecents] = useState<AskRow[]>([]);
  const [focusSignal, setFocusSignal] = useState(0);
  const [asked, setAsked] = useState(0);

  // Shell meta lives here so the rail's status block and the composer's model
  // label come from one poll rather than two.
  usePoll(boot, async () => {
    const h = await client.health();
    setUp(!!h?.ok);
    setVersion(h?.version ?? "");
    const e = await client.engine();
    setEngine(e === null ? "" : e.hasKey ? "Claude API" : e.ollama.hasModel ? (e.ollama.models[0] ?? "ollama") : "no engine");
    const q = await client.questions();
    if (q) setRecents(q.items);
  });

  // A dashboard ask lands in /questions immediately — refresh the rail after one.
  usePoll(boot, async () => {
    if (!asked) return;
    const q = await client.questions();
    if (q) setRecents(q.items);
  }, 4000);

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(RAIL_KEY, next ? "collapsed" : "open");
    } catch {
      // storage blocked — collapse state just won't persist
    }
  };

  const askNow = () => {
    if (area !== "mirror") location.hash = "#/mirror";
    setFocusSignal((n) => n + 1);
  };

  const meta = AREAS_META[area];

  return (
    <div class={`shell${collapsed ? " collapsed" : ""}`}>
      <Rail
        active={area}
        collapsed={collapsed}
        onToggle={toggle}
        onAsk={askNow}
        recents={recents}
        status={{ up, demo: boot === "demo", version, engine }}
      />
      <header class="topbar">
        <span class="title">{meta.title}</span>
        <span class="spacer" />
        {boot === "demo" && <span class="ribbon">Preview — sample data, nothing is real</span>}
      </header>
      {area === "mirror" ? (
        <MirrorView
          client={client}
          boot={boot}
          model={engine || "no engine"}
          focusSignal={focusSignal}
          onAsked={() => setAsked((n) => n + 1)}
        />
      ) : (
        <div class="canvas">
          <div class="flow">
            <div class="flow-col">
              <StubView title={meta.title} purpose={meta.purpose} demo={client.mode === "demo"} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
