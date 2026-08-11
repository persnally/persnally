/** Rail and control icons — one consistent 16px stroke set, currentColor, no icon library. */

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

export const MirrorIcon = () => (
  <svg {...S}>
    <path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

export const DataIcon = () => (
  <svg {...S}>
    <ellipse cx="12" cy="5.5" rx="7.5" ry="3" />
    <path d="M4.5 5.5v6c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3v-6" />
    <path d="M4.5 11.5v6c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3v-6" />
  </svg>
);

export const AccessIcon = () => (
  <svg {...S}>
    <path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Z" />
    <path d="M9.5 12l2 2 3.5-4" />
  </svg>
);

export const ConnectionsIcon = () => (
  <svg {...S}>
    <path d="M8 7h9m0 0-3-3m3 3-3 3" />
    <path d="M16 17H7m0 0 3 3m-3-3 3-3" />
  </svg>
);

export const ControlIcon = () => (
  <svg {...S}>
    <path d="M4 8h10M18 8h2M4 16h2M10 16h10" />
    <circle cx="16" cy="8" r="2.2" />
    <circle cx="8" cy="16" r="2.2" />
  </svg>
);

/** Sidebar show/hide — the toggle both reference apps put at the top of the rail. */
export const PanelIcon = () => (
  <svg {...S}>
    <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
    <path d="M9.5 4.5v15" />
  </svg>
);

export const PlusIcon = () => (
  <svg {...S}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

/** Recent asks — a question, not a chat bubble. */
export const AskIcon = () => (
  <svg {...S}>
    <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.6 9.6 0 0 1-2.8-.4L4 21l1.4-4.1A8.2 8.2 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4Z" />
  </svg>
);

export const SendIcon = () => (
  <svg {...S} stroke-width={2}>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </svg>
);
