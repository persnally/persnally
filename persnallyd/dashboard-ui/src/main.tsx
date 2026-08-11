import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { createClient } from "./api/client";
import { resolveBoot, type Boot } from "./lib/boot-state";
import { NoDaemon, SignedOut } from "./shell/Overlays";
import { App } from "./app";
import "./styles/tokens.css";
import "./styles/app.css";

/**
 * Boot: probe the daemon once, resolve the trust state, then render. A 401
 * mid-session flips to signed-out through the client's onUnauthorized hook —
 * live data never silently degrades into sample data.
 */
function Root() {
  const [boot, setBoot] = useState<Boot | undefined>(undefined);

  useEffect(() => {
    void createClient("live")
      .probe()
      .then((p) => setBoot(resolveBoot(p === "unauthorized", p === "unreachable")));
  }, []);

  const client = useMemo(
    () => (boot === "live" || boot === "demo" ? createClient(boot, () => setBoot("signed-out")) : null),
    [boot],
  );

  if (boot === undefined) return null;
  if (boot === "signed-out") return <SignedOut />;
  if (boot === "no-daemon") return <NoDaemon />;
  return client && <App client={client} boot={boot} />;
}

render(<Root />, document.getElementById("app")!);
