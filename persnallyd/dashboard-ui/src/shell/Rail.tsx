import type { ComponentType } from "preact";
import type { Area } from "../lib/use-hash-route";
import { AccessIcon, ConnectionsIcon, ControlIcon, DataIcon, MirrorIcon } from "./icons";
import { Mark } from "./Mark";

const ITEMS: { area: Area; label: string; Icon: ComponentType }[] = [
  { area: "mirror", label: "Mirror", Icon: MirrorIcon },
  { area: "data", label: "Data", Icon: DataIcon },
  { area: "access", label: "Access", Icon: AccessIcon },
  { area: "connections", label: "Connections", Icon: ConnectionsIcon },
  { area: "control", label: "Control", Icon: ControlIcon },
];

export function Rail({ active, collapsed, onToggle }: { active: Area; collapsed: boolean; onToggle: () => void }) {
  return (
    <nav class="rail" aria-label="Areas">
      <div class="rail-brand">
        <Mark />
        <span class="label">Persnally</span>
      </div>
      {ITEMS.map(({ area, label, Icon }) => (
        <a key={area} class={`rail-item${area === active ? " active" : ""}`} href={`#/${area}`} title={label}>
          <span class="glyph">
            <Icon />
          </span>
          <span class="label">{label}</span>
        </a>
      ))}
      <div class="rail-foot">
        <button class="rail-collapse" onClick={onToggle} title={collapsed ? "Expand" : "Collapse"}>
          {collapsed ? "»" : "«"} <span class="label">Collapse</span>
        </button>
      </div>
    </nav>
  );
}
