/**
 * What the extraction engine last did, so the dashboard can say so.
 *
 * A configured key is not a working key: a credit-exhausted or revoked one
 * fails every call while every surface still reports "Claude API". This module
 * is the daemon's memory of that, kept in process — the log already has the
 * detail, this is the part a user needs to see.
 */

export interface EngineFailure {
  at: string;
  message: string;
  /** Consecutive failures since the last success — 1 is a blip, 900 is broken. */
  count: number;
}

let failure: EngineFailure | null = null;

/** One line, no stack, no JSON envelope — this is rendered to a person. */
function readable(raw: string): string {
  const json = /"message"\s*:\s*"([^"]+)"/.exec(raw)?.[1];
  return (json ?? raw).split("\n")[0]!.slice(0, 300);
}

export function recordEngineFailure(e: unknown): void {
  const message = readable(e instanceof Error ? e.message : String(e));
  failure = { at: new Date().toISOString(), message, count: (failure?.count ?? 0) + 1 };
}

export function recordEngineSuccess(): void {
  failure = null;
}

export function engineFailure(): EngineFailure | null {
  return failure;
}
