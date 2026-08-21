import type { ImportResult } from "../api/types";
import { fmtN } from "./format";

/**
 * What the import actually did. Shared so the two places that offer an import
 * can't drift apart — and so neither can say "Imported." about a run that
 * found nothing, which is the one thing a custody surface can't afford.
 */
export function importedText(r: ImportResult): string {
  if (r.events > 0) {
    return `Imported ${fmtN(r.events)} event${r.events === 1 ? "" : "s"} from ${r.imported.join(", ")}.`;
  }
  if (r.skipped.length > 0) return `Nothing new — already imported: ${r.skipped.join(", ")}.`;
  return "Nothing found to import. Put a ChatGPT or Claude export in ~/Downloads, or use persnally import git <path>.";
}
