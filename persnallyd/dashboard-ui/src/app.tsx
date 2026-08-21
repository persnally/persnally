import { useState } from "preact/hooks";
import type { PersnallyClient } from "./api/client";
import type { AskRow } from "./api/types";
import type { Boot } from "./lib/boot-state";
import { usePoll } from "./lib/use-poll";
import { useHashRoute } from "./lib/use-hash-route";
import { AREAS_META } from "./shell/areas";
import { Rail } from "./shell/Rail";
import { AccessView } from "./views/access/AccessView";
import { ConnectionsView } from "./views/connections/ConnectionsView";
import { ControlView } from "./views/control/ControlView";
import { DataView } from "./views/data/DataView";
import { MirrorView } from "./views/mirror/MirrorView";
import { PanelIcon } from "./shell/icons";

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
  const [up, setUp] = useState<boolean | null>(null); // null = not asked yet
  const [version, setVersion] = useState("");
  const [engine, setEngine] = useState("");
  const [recents, setRecents] = useState<AskRow[]>([]);
  const [focusSignal, setFocusSignal] = useState(0);
  const [opened, setOpened] = useState<AskRow | null>(null);

  // Shell meta lives here so the rail's status block and the composer's model
  // label come from one poll rather than several.
  usePoll(boot, async () => {
    const h = await client.health();
    setUp(!!h?.ok);
    setVersion(h?.version ?? "");
    const e = await client.engine();
    const label = e === null ? "" : e.hasKey ? "Claude API" : (e.models.extract ?? "no engine");
    // A failing engine is reported here too — the footer is the only thing on
    // screen in every view, and "Claude API" alone read as working.
    setEngine(e?.lastFailure ? `${label} — failing` : label);
    const q = await client.questions();
    // Cleared on failure like the rest of the status block: a rail still
    // listing asks under "daemon unreachable" invites clicking into stale data.
    setRecents(q ? q.items : []);
  });

  // A dashboard ask lands in /questions immediately, so refresh on the event
  // rather than polling for it (a second interval read a stale `asked`).
  const refreshRecents = async () => {
    const q = await client.questions();
    if (q) setRecents(q.items);
  };

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

  const openAsk = (row: AskRow) => {
    setOpened(row);
    if (area !== "mirror") location.hash = "#/mirror";
  };

  const meta = AREAS_META[area];

  return (
    <div class={`shell${collapsed ? " collapsed" : ""}`}>
      {/* Hit zone along the window's left edge: hovering it slides the hidden
          rail back over the canvas, and moving into the rail keeps it there. */}
      {collapsed && <div class="edge-peek" aria-hidden="true" />}
      <Rail
        active={area}
        collapsed={collapsed}
        onToggle={toggle}
        onAsk={askNow}
        recents={recents}
        onOpenAsk={openAsk}
        openedId={opened?.answer_id ?? null}
        status={{ up, demo: boot === "demo", version, engine }}
      />
      <header class="topbar">
        {collapsed && (
          <button class="topbar-toggle" onClick={toggle} title="Show sidebar" aria-expanded={false}>
            <PanelIcon />
          </button>
        )}
        <span class="title">{meta.title}</span>
        <span class="sub">{meta.purpose}</span>
        <span class="spacer" />
        {boot === "demo" && <span class="ribbon">Preview — sample data, nothing is real</span>}
      </header>

      {area === "mirror" && (
        <MirrorView
          client={client}
          boot={boot}
          model={engine || "no engine"}
          focusSignal={focusSignal}
          onAsked={() => void refreshRecents()}
          opened={opened}
          onClearOpened={() => setOpened(null)}
        />
      )}
      {area !== "mirror" && (
        <div class="canvas">
          <div class="flow">
            {area === "data" && <DataView client={client} boot={boot} />}
            {area === "access" && <AccessView client={client} boot={boot} />}
            {area === "connections" && <ConnectionsView client={client} boot={boot} />}
            {area === "control" && <ControlView client={client} boot={boot} />}
          </div>
        </div>
      )}
    </div>
  );
}
