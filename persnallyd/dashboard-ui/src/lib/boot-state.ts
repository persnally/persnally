/**
 * The trust logic of the whole page, in one pure module. The invariants here
 * are asserted by test/dashboard-next.test.ts — a real user must NEVER see
 * fabricated data:
 *   - demo is opt-in via the query string, nothing else
 *   - a 401 is a signed-out state, it never falls through to demo
 *   - an unreachable daemon without ?demo=1 is an honest "not running" page
 */

export const PREVIEW = new URLSearchParams(location.search).has("demo");

export type Boot = "live" | "signed-out" | "no-daemon" | "demo";

export function resolveBoot(unauthorized: boolean, unreachable: boolean): Boot {
  if (unauthorized) return "signed-out";
  if (!unreachable) return "live";
  if (!PREVIEW) return "no-daemon";
  return "demo";
}
