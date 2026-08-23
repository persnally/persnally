import { useEffect, useState } from "preact/hooks";

export const AREAS = ["mirror", "data", "access", "connections", "control"] as const;
export type Area = (typeof AREAS)[number];

const parse = (): Area => {
  const h = location.hash.replace(/^#\/?/, "");
  return (AREAS as readonly string[]).includes(h) ? (h as Area) : "mirror";
};

export function useHashRoute(): Area {
  const [area, setArea] = useState<Area>(parse);
  useEffect(() => {
    const on = () => setArea(parse());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return area;
}
