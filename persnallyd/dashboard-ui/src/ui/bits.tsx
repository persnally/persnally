import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";

/** Small shared pieces every area uses. Squared, like everything else. */

export function Panel({ title, sub, children, action }: { title: string; sub?: string; children: ComponentChildren; action?: ComponentChildren }) {
  return (
    <section class="panel reveal">
      <div class="panel-head">
        <div>
          <h2>{title}</h2>
          {sub && <p class="panel-sub">{sub}</p>}
        </div>
        {action && <div class="panel-action">{action}</div>}
      </div>
      {children}
    </section>
  );
}

export function Bar({ value, max = 1, tone }: { value: number; max?: number; tone?: string }) {
  const pct = Math.max(0, Math.min(100, (value / (max || 1)) * 100));
  return (
    <span class="bar">
      <span class="bar-fill" style={`width:${pct}%${tone ? `;background:${tone}` : ""}`} />
    </span>
  );
}

export function Empty({ children }: { children: ComponentChildren }) {
  return <p class="panel-empty">{children}</p>;
}

/** A destructive action that asks once, inline — no browser confirm() dialog. */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  disabled,
  title,
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
  disabled?: boolean;
  title?: string;
}) {
  const [armed, setArmed] = useState(false);
  if (!armed) {
    return (
      <button class="mini" disabled={disabled} title={title} onClick={() => setArmed(true)}>
        {label}
      </button>
    );
  }
  return (
    <span class="confirm">
      <button
        class="mini danger"
        disabled={disabled}
        onClick={() => {
          setArmed(false);
          onConfirm();
        }}
      >
        {confirmLabel}
      </button>
      <button class="mini" onClick={() => setArmed(false)}>
        cancel
      </button>
    </span>
  );
}

/** Result line for a mutation or an action — success and failure both visible. */
export function Flash({ msg }: { msg: { ok: boolean; text: string } | null }) {
  if (!msg) return null;
  return <p class={msg.ok ? "flash" : "flash bad"}>{msg.text}</p>;
}
