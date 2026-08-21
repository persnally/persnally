import type { Area } from "../lib/use-hash-route";

/** Title + the one-line answer each area gives, shown beside the title. */
export const AREAS_META: Record<Area, { title: string; purpose: string }> = {
  mirror: { title: "Mirror", purpose: "What it knows about you" },
  data: { title: "Data", purpose: "What that is built from" },
  access: { title: "Access", purpose: "Who reads it, and what" },
  connections: { title: "Connections", purpose: "What feeds it" },
  control: { title: "Control", purpose: "Who's in charge here" },
};
