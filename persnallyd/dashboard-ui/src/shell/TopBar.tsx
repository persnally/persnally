import { useState } from "preact/hooks";
import type { PersnallyClient } from "../api/client";
import type { Boot } from "../lib/boot-state";
import { usePoll } from "../lib/use-poll";

/** Status dot + engine label + version — the "is my daemon alive" strip. */
export function TopBar({ client, boot }: { client: PersnallyClient; boot: Boot }) {
  const [version, setVersion] = useState<string>("");
  const [up, setUp] = useState(false);
  const [engineLabel, setEngineLabel] = useState<string>("");

  usePoll(boot, async () => {
    const h = await client.health();
    setUp(!!h?.ok);
    setVersion(h?.version ?? "");
    const e = await client.engine();
    setEngineLabel(
      e === null ? "" : e.hasKey ? "Claude API" : e.ollama.hasModel ? `local · ${e.ollama.models[0] ?? "ollama"}` : "no engine",
    );
  });

  const demo = boot === "demo";
  return (
    <header class="topbar">
      <span class={`dot${demo ? " preview" : up ? " on" : ""}`} title={demo ? "preview" : up ? "daemon running" : "daemon unreachable"} />
      <span class="meta">{demo ? "preview" : up ? "daemon running" : "daemon unreachable"}</span>
      {engineLabel && !demo && <span class="meta">engine: {engineLabel}</span>}
      <span class="spacer" />
      {demo && <span class="ribbon">Preview — sample data, nothing is real</span>}
      {version && !demo && <span class="num">v{version}</span>}
    </header>
  );
}
