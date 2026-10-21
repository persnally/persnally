import { useState } from "preact/hooks";
import type { PersnallyClient } from "./api/client";
import type { Boot } from "./lib/boot-state";
import { usePoll } from "./lib/use-poll";
import { useHashRoute } from "./lib/use-hash-route";
import { AREAS_META } from "./shell/areas";
import { Rail } from "./shell/Rail";
import { AccessView } from "./views/access/AccessView";
import { AnswersView } from "./views/answers/AnswersView";
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

  // Shell meta lives here so the rail's status block comes from one poll.
  usePoll(boot, async () => {
    const h = await client.health();
    setUp(!!h?.ok);
    setVersion(h?.version ?? "");
    const e = await client.engine();
    const label = e === null ? "" : e.hasKey ? "Claude API" : (e.models.extract ?? "no engine");
    // A failing engine is reported here too — the footer is the only thing on
    // screen in every view, and "Claude API" alone read as working.
    setEngine(e?.lastFailure ? `${label} — failing` : label);
  });

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(RAIL_KEY, next ? "collapsed" : "open");
    } catch {
      // storage blocked — collapse state just won't persist
    }
  };

  const meta = AREAS_META[area];

  return (
    <div class={`shell${collapsed ? " collapsed" : ""}`}>
      {/* Hit zone along the window's left edge: hovering it slides the hidden
          rail back over the canvas, and moving into the rail keeps it there. */}
      {collapsed && <div class="edge-peek" aria-hidden="true" />}
      <Rail active={area} collapsed={collapsed} onToggle={toggle} status={{ up, demo: boot === "demo", version, engine }} />
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

      {area === "mirror" ? (
        <MirrorView client={client} boot={boot} />
      ) : (
        <div class="canvas">
          <div class="flow">
            {area === "answers" && <AnswersView client={client} boot={boot} />}
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
