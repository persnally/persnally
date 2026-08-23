import { useRef, useState } from "preact/hooks";
import { SendIcon } from "../../shell/icons";

/**
 * The docked composer. Presentational: the parent owns the ask call and the
 * answer flow, so answers read as a conversation continuing under the portrait.
 */

const MAX = 500;

export interface AskComposerProps {
  onSubmit: (question: string) => void;
  busy: boolean;
  cooling: boolean;
  model: string;
  demo: boolean;
  focusSignal: number;
}

export function AskComposer({ onSubmit, busy, cooling, model, demo, focusSignal }: AskComposerProps) {
  const [q, setQ] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  const lastFocus = useRef(focusSignal);

  if (lastFocus.current !== focusSignal) {
    lastFocus.current = focusSignal;
    box.current?.focus();
  }

  const sendable = q.trim().length >= 1 && q.length <= MAX && !busy && !cooling;

  function send() {
    if (!sendable) return;
    onSubmit(q.trim());
    setQ("");
    const el = box.current;
    if (el) el.style.height = "auto";
  }

  return (
    <div class="ask">
      <textarea
        ref={box}
        value={q}
        maxLength={MAX + 50}
        rows={1}
        placeholder="Ask what your model would say…"
        disabled={busy}
        onInput={(e) => {
          const el = e.target as HTMLTextAreaElement;
          setQ(el.value);
          el.style.height = "auto";
          el.style.height = `${Math.min(el.scrollHeight, 190)}px`;
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div class="ask-foot">
        {q.length > MAX - 100 && <span class="ask-count num">{q.length}/{MAX}</span>}
        <span class="ask-model">{demo ? "sample" : model}</span>
        <button
          class={`ask-send${busy ? " waiting" : ""}`}
          disabled={!sendable}
          onClick={send}
          title={cooling ? "Rate limited — cooling down" : "Ask (Enter)"}
          aria-label="Ask"
        >
          <SendIcon />
        </button>
      </div>
    </div>
  );
}
