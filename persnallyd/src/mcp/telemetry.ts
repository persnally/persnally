/**
 * Local-only telemetry for the Phase 0 capture-rate experiment.
 * Appends one JSON line per event to ~/.persnally/telemetry.jsonl — counts and
 * timestamps only, never conversation content. Analyzed by experiments/capture_rate.py.
 */

import { appendFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { ensurePrivateDir, ensurePrivateFile, FILE_MODE } from "../paths.js";

const DIR = join(homedir(), ".persnally");
const FILE = join(DIR, "telemetry.jsonl");

let clientName = "unknown";

export function setClient(name: string | undefined): void {
  if (name) clientName = name;
}

export function getClient(): string {
  // The connect-time env pin wins over the handshake's self-reported name —
  // identity must match the name the daemon issued a token for.
  return process.env.PERSNALLY_CLIENT || clientName;
}

export function logEvent(event: string, data: Record<string, unknown> = {}): void {
  try {
    ensurePrivateDir(DIR);
    const line = JSON.stringify({ ts: new Date().toISOString(), event, client: clientName, ...data });
    // Names which AI clients this user runs and when — owner-only on create.
    appendFileSync(FILE, line + "\n", { mode: FILE_MODE });
    ensurePrivateFile(FILE);
  } catch {
    // Telemetry must never break the server.
  }
}
