/**
 * Event payloads arrive as `Record<string, unknown>` — their shape varies by
 * event type and by how old the event is. Reading a field directly is how one
 * unexpected type takes down a whole view during render, so every payload read
 * goes through these.
 */

export const str = (v: unknown, fallback = ""): string =>
  typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : fallback;

export const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/** Joins a value that may be a list, a single string, or absent. */
export const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean) : typeof v === "string" && v ? [v] : [];
