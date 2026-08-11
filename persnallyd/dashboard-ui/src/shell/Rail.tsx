import type { ComponentType } from "preact";
import type { AskRow } from "../api/types";
import type { Area } from "../lib/use-hash-route";
import { AccessIcon, AskIcon, ConnectionsIcon, ControlIcon, DataIcon, MirrorIcon, PanelIcon, PlusIcon } from "./icons";
import { Mark } from "./Mark";

const ITEMS: { area: Area; label: string; Icon: ComponentType }[] = [
  { area: "mirror", label: "Mirror", Icon: MirrorIcon },
  { area: "data", label: "Data", Icon: DataIcon },
  { area: "access", label: "Access", Icon: AccessIcon },
  { area: "connections", label: "Connections", Icon: ConnectionsIcon },
  { area: "control", label: "Control", Icon: ControlIcon },
];

export interface RailProps {
  active: Area;
  collapsed: boolean;
  onToggle: () => void;
  onAsk: () => void;
  recents: AskRow[];
  /** Opening a past ask drops it into the Mirror thread — no dead links. */
  onOpenAsk: (row: AskRow) => void;
  openedId: string | null;
  status: { up: boolean; demo: boolean; version: string; engine: string };
}

export function Rail({ active, collapsed, onToggle, onAsk, recents, onOpenAsk, openedId, status }: RailProps) {
  const { up, demo, version, engine } = status;
  return (
    <nav class="rail" aria-label="Areas">
      <div class="rail-head">
        <Mark />
        <span class="wordmark">persnally</span>
        <span class="spacer" />
        <button class="rail-toggle" onClick={onToggle} title={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!collapsed}>
          <PanelIcon />
        </button>
      </div>

      <button class="rail-primary" onClick={onAsk} title="Ask your model">
        <span class="glyph"><PlusIcon /></span>
        <span class="label">Ask</span>
      </button>

      <div class="rail-nav">
        {ITEMS.map(({ area, label, Icon }) => (
          <a key={area} class={`rail-item${area === active ? " active" : ""}`} href={`#/${area}`} title={label}>
            <span class="glyph"><Icon /></span>
            <span class="label">{label}</span>
          </a>
        ))}
      </div>

      <div class="rail-scroll">
        <div class="rail-label">Recent asks</div>
        {recents.length === 0 ? (
          <div class="rail-hint">Questions your AIs ask show up here.</div>
        ) : (
          recents.map((r) => (
            <button
              key={r.answer_id}
              class={`rail-item${openedId === r.answer_id ? " active" : ""}`}
              onClick={() => onOpenAsk(r)}
              title={`${r.asker}: ${r.question}${r.deferred ? " (deferred)" : ""}`}
            >
              <span class="glyph"><AskIcon /></span>
              <span class="label">{r.question}</span>
            </button>
          ))
        )}
      </div>

      <div class="rail-foot" title={demo ? "preview" : up ? `daemon running · ${engine}` : "daemon unreachable"}>
        <span class={`dot${demo ? " preview" : up ? " on" : ""}`} />
        <span class="stack">
          <span class="line1">{demo ? "preview" : up ? "daemon running" : "daemon unreachable"}</span>
          <span class="line2">{demo ? "sample data" : [engine, version && `v${version}`].filter(Boolean).join(" · ")}</span>
        </span>
      </div>
    </nav>
  );
}
