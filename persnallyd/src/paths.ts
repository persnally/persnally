import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** All local state lives here. PERSNALLY_DIR override exists for tests and power users. */
export const DATA_DIR = process.env.PERSNALLY_DIR ?? join(homedir(), ".persnally");

/** Owner-only, the mode ~/.ssh uses. */
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/**
 * Everything under DATA_DIR is the user's own model of themselves, plus the
 * credentials guarding it. At the default 0644 any other user on the machine
 * can read it directly, which makes every check the daemon performs moot —
 * so the directory is the real boundary and the file modes are depth behind it.
 *
 * Modes are enforced on existing paths too: `mkdirSync` ignores `mode` when the
 * directory already exists, so installs created before this stay open otherwise.
 */
export function ensurePrivateDir(dir: string = DATA_DIR): void {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  harden(dir, DIR_MODE);
}

export function ensurePrivateFile(file: string): void {
  harden(file, FILE_MODE);
}

/** A filesystem that can't express the mode (network mounts, exotic FS) must not
    take the daemon down with it — but it says so rather than failing quietly. */
function harden(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    console.error(`persnally: could not restrict ${path} to ${mode.toString(8)} — ${(e as Error).message}`);
  }
}
