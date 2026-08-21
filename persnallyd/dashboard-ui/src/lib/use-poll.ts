import { useEffect } from "preact/hooks";
import type { Boot } from "./boot-state";

/**
 * The refresh loop. Successor of the classic page's
 * `if (DEMO || SIGNED_OUT || DAEMON_DOWN) return;` gate — the poll runs the
 * callback immediately, then only ticks while the boot state is "live" and
 * the tab is visible. Asserted by test/dashboard-next.test.ts.
 */
export function usePoll(boot: Boot, fn: () => void | Promise<void>, ms = 25_000): void {
  useEffect(() => {
    void fn();
    const tick = () => {
      if (boot !== "live" || document.hidden) return;
      void fn();
    };
    const id = setInterval(tick, ms);
    return () => clearInterval(id);
    // deps: fn is intentionally captured once per boot state, not per render
  }, [boot, ms]);
}
