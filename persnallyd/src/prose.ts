/**
 * Corpus hygiene. Imported prompts are polluted with pasted data (file paths,
 * URLs, JSON/logs) and injected blocks (task notifications, reminders, command
 * palettes, tool output). Unfiltered, that noise swamps both topic extraction
 * and the voice fingerprint. See docs/CONTEXT_DEPTH.md.
 */

// A line with at least one of these reads as a sentence, not pasted data.
const FUNCTION_WORD =
  /\b(the|a|an|i|to|and|is|it|you|we|that|this|of|for|in|on|do|are|be|can|should|need|want|make|how|what|why|let|so|but|not|just|with|like|now|also|when|if|because|about)\b/;

// Machine/agent output that reads prose-like but isn't the user's writing: CLI/tool
// output and Claude Code's own rate-limit/session notices. These survive FUNCTION_WORD
// (they contain "you've"/"your"), so without this they pollute the voice fingerprint.
export const MACHINE_LINE =
  /(exit code|session limit|limit resets?|hit your .*limit|you've hit|usage limit|resets? (at |in |\d)|\/upgrade|command not found|no such file|traceback \(most recent|npm (error|warn)|fatal:)/i;

/** Remove injected blocks, fenced code, URLs, and filesystem paths. Keeps prose intact. */
export function stripNoise(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<(?:task-notification|system-reminder|local-command[^>]*|command-[^>]*)>[\s\S]*?<\/[^>]+>/gi, " ")
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/(?:[~\w.-]+)?(?:\/[\w.-]+){2,}\/?/g, " ") // /a/b style paths
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Strict: only the prose lines a human actually wrote — for stylometry. */
export function proseLines(text: string): string[] {
  return stripNoise(text)
    .split("\n")
    .map((l) => l.trim())
    .filter((ln) => {
      if (ln.split(/\s+/).length < 2) return false;
      if (MACHINE_LINE.test(ln)) return false; // CLI/tool output + rate-limit notices, not prose
      const letters = (ln.match(/[a-zA-Z]/g) || []).length;
      if (!ln.length || letters / ln.length < 0.6) return false; // json/logs/ids
      return FUNCTION_WORD.test(" " + ln.toLowerCase() + " ");
    });
}
