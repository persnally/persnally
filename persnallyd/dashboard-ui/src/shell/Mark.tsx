import markUrl from "../assets/persnally-mark.png";

/** The Persnally mark, the same asset the classic dashboard carries in its
    header. Inlined by the single-file build — no external request. */
export function Mark({ class: cls = "mark" }: { class?: string }) {
  return <img class={cls} src={markUrl} alt="" aria-hidden="true" width={22} height={22} />;
}
