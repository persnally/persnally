/**
 * Rail and control icons — one hand-drawn stroke set, no icon library.
 *
 * House rules, because a mismatched set reads as sloppiness at 16px: 24×24
 * viewBox, every glyph sized to fill an ~17-unit optical box centred in it
 * (x and y from ~3.5 to ~20.5), one stroke weight for all of them, round caps.
 * Optical mass matters more than exact bounds — a glyph that spans 10 units
 * next to one that spans 19 looks broken even though both are "16px".
 */

const S = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": 1.8,
  "stroke-linecap": "round" as const,
  "stroke-linejoin": "round" as const,
  "aria-hidden": true,
};

/** Mirror — what it knows about you. */
export const MirrorIcon = () => (
  <svg {...S}>
    <path d="M3.5 12c2.1-3.8 5.1-5.8 8.5-5.8s6.4 2 8.5 5.8c-2.1 3.8-5.1 5.8-8.5 5.8S5.6 15.8 3.5 12Z" />
    <circle cx="12" cy="12" r="2.7" />
  </svg>
);

/** Data — the event log itself. */
export const DataIcon = () => (
  <svg {...S}>
    <ellipse cx="12" cy="6.8" rx="8" ry="2.7" />
    <path d="M4 6.8v10.4c0 1.5 3.58 2.7 8 2.7s8-1.2 8-2.7V6.8" />
    <path d="M4 12c0 1.5 3.58 2.7 8 2.7s8-1.2 8-2.7" />
  </svg>
);

/** Access — a grant that has been checked. */
export const AccessIcon = () => (
  <svg {...S}>
    <path d="M12 3.4 4.6 6.5v4.9c0 4.4 3 7.9 7.4 9.4 4.4-1.5 7.4-5 7.4-9.4V6.5L12 3.4Z" />
    <path d="M8.9 12.1l2.3 2.3 4-4.5" />
  </svg>
);

/** Connections — context out, events back. */
export const ConnectionsIcon = () => (
  <svg {...S}>
    <path d="M3.5 8.6h17m0 0-3.8-3.8m3.8 3.8-3.8 3.8" />
    <path d="M20.5 15.4h-17m0 0 3.8 3.8m-3.8-3.8 3.8-3.8" />
  </svg>
);

/** Control — the knobs you own. */
export const ControlIcon = () => (
  <svg {...S}>
    <path d="M3.5 8.2h8.2M16.7 8.2h3.8" />
    <circle cx="14.2" cy="8.2" r="2.5" />
    <path d="M3.5 15.8h3.2M11.5 15.8h9" />
    <circle cx="9" cy="15.8" r="2.5" />
  </svg>
);

/** Sidebar show/hide — the toggle both reference apps put at the top of the rail. */
export const PanelIcon = () => (
  <svg {...S}>
    <rect x="3.5" y="4.2" width="17" height="15.6" rx="2.4" />
    <path d="M9.6 4.2v15.6" />
  </svg>
);

export const PlusIcon = () => (
  <svg {...S}>
    <path d="M12 4.8v14.4M4.8 12h14.4" />
  </svg>
);

/** Recent asks — a speech bubble: these are questions your AIs asked. */
export const AskIcon = () => (
  <svg {...S}>
    <path d="M20.5 11.7c0 4.3-3.8 7.8-8.5 7.8-1 0-2-.16-2.9-.45L3.9 20.6l1.5-4.2a7.4 7.4 0 0 1-1.9-4.7c0-4.3 3.8-7.8 8.5-7.8s8.5 3.5 8.5 7.8Z" />
  </svg>
);

export const SendIcon = () => (
  <svg {...S}>
    <path d="M12 19.2V4.8M5.2 11.6 12 4.8l6.8 6.8" />
  </svg>
);
