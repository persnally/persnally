import type { Area } from "../lib/use-hash-route";

/** Title + one-line purpose per area. The purpose lines double as the stub copy
    for areas whose full build lands in a later slice. */
export const AREAS_META: Record<Area, { title: string; purpose: string }> = {
  mirror: {
    title: "Mirror",
    purpose: "What it knows about you, and what your model would say.",
  },
  data: {
    title: "Data",
    purpose:
      'What the model is built from: every topic, assertion, and skill — labelled, filterable, deletable. The interest map and the "since you last looked" delta land here.',
  },
  access: {
    title: "Access",
    purpose:
      "Who reads it, and what: per-client scopes, revoke and restore, and the audit trail of every context read and every question your AIs asked.",
  },
  connections: {
    title: "Connections",
    purpose:
      "What feeds it: your eight AI clients, imports, and the extraction engine — connect a new source in one step.",
  },
  control: {
    title: "Control",
    purpose:
      "Who's in charge here: re-synthesize, reflect, export everything, judge answers, and the settings that decide which models run.",
  },
};
