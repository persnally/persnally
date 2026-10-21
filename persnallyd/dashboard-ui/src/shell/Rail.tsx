import type { ComponentType } from "preact";
import type { Area } from "../lib/use-hash-route";
import { AccessIcon, AskIcon, ConnectionsIcon, ControlIcon, DataIcon, MirrorIcon, PanelIcon } from "./icons";
import { Mark } from "./Mark";

const ITEMS: { area: Area; label: string; Icon: ComponentType }[] = [
  { area: "answers", label: "Answers", Icon: AskIcon },
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
  /** up === null: the first /health hasn't answered yet — state unknown. */
  status: { up: boolean | null; demo: boolean; version: string; engine: string };
}

export function Rail({ active, collapsed, onToggle, status }: RailProps) {
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

      <div class="rail-nav">
        {ITEMS.map(({ area, label, Icon }) => (
          <a key={area} class={`rail-item${area === active ? " active" : ""}`} href={`#/${area}`} title={label}>
            <span class="glyph"><Icon /></span>
            <span class="label">{label}</span>
          </a>
        ))}
      </div>

      <div class="rail-foot" title={demo ? "preview" : up === null ? "checking the daemon" : up ? `daemon running · ${engine}` : "daemon unreachable"}>
        <span class={`dot${demo ? " preview" : up ? " on" : ""}`} />
        <span class="stack">
          {/* null is "not asked yet" — claiming "unreachable" before the first
              /health lands states something we don't know. */}
          <span class="line1">{demo ? "preview" : up === null ? "checking…" : up ? "daemon running" : "daemon unreachable"}</span>
          <span class="line2">{demo ? "sample data" : [engine, version && `v${version}`].filter(Boolean).join(" · ")}</span>
        </span>
      </div>
    </nav>
  );
}
