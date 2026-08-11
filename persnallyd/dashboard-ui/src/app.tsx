import { useState } from "preact/hooks";
import type { PersnallyClient } from "./api/client";
import type { Boot } from "./lib/boot-state";
import { useHashRoute } from "./lib/use-hash-route";
import { Rail } from "./shell/Rail";
import { StubView } from "./shell/StubView";
import { TopBar } from "./shell/TopBar";
import { MirrorView } from "./views/mirror/MirrorView";

const RAIL_KEY = "persnally.ui.rail";

const STUBS = {
  data: {
    title: "Data",
    purpose:
      "What the model is built from: every topic, assertion, and skill — labelled, filterable, deletable. The interest map and the \"since you last looked\" delta land here.",
  },
  access: {
    title: "Access",
    purpose:
      "Who reads it, and what: per-client scopes, revoke and restore, and the audit trail of every context read and every question your AIs asked.",
  },
  connections: {
    title: "Connections",
    purpose: "What feeds it: your eight AI clients, imports, and the extraction engine — connect a new source in one step.",
  },
  control: {
    title: "Control",
    purpose:
      "Who's in charge here: re-synthesize, reflect, export everything, judge answers, and the settings that decide which models run.",
  },
} as const;

export function App({ client, boot }: { client: PersnallyClient; boot: Boot }) {
  const area = useHashRoute();
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(RAIL_KEY) === "collapsed";
    } catch {
      return false; // storage blocked — default open, don't crash the first render
    }
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

  return (
    <div class={`shell${collapsed ? " collapsed" : ""}`}>
      <Rail active={area} collapsed={collapsed} onToggle={toggle} />
      <TopBar client={client} boot={boot} />
      <main class="canvas">
        {area === "mirror" ? (
          <MirrorView client={client} boot={boot} />
        ) : (
          <div class="canvas-col">
            <StubView title={STUBS[area].title} purpose={STUBS[area].purpose} demo={client.mode === "demo"} />
          </div>
        )}
      </main>
    </div>
  );
}
