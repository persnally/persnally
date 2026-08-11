/**
 * The "since you last looked" baseline. Key and shape are a compatibility
 * contract with the classic dashboard — existing users' delta baselines must
 * survive the cutover. Rendered by the Data view (a later slice); the module
 * establishes the contract now.
 */

const SNAP_KEY = "persnally.snapshot.v1";

export interface Snapshot {
  t: string;
  weights: Record<string, number>;
}

export function readSnapshot(): Snapshot | null {
  try {
    const raw = localStorage.getItem(SNAP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Snapshot;
    if (!parsed || typeof parsed.t !== "string") return null;
    const w = parsed.weights;
    if (typeof w !== "object" || w === null || Array.isArray(w)) return null;
    if (!Object.values(w).every((v) => typeof v === "number" && Number.isFinite(v))) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveSnapshot(weights: Record<string, number>): void {
  try {
    localStorage.setItem(SNAP_KEY, JSON.stringify({ t: new Date().toISOString(), weights }));
  } catch {
    // storage full or blocked — the delta strip just resets, nothing breaks
  }
}
