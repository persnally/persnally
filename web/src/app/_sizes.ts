/**
 * How wide each plate is actually painted, so the browser picks a source
 * instead of assuming 100vw. These are painted widths, not box widths: the
 * `object-contain` vignettes are capped by their height × aspect, so they stop
 * growing well before their column does.
 *
 * Geometry: Section is max-w-6xl (1152) + px-6, so content = min(100vw, 1152)
 * − 3rem. Tailwind md = 48rem, lg = 64rem. Each declaration must be ≥ the
 * painted width at every viewport — under-declaring serves a blurry source.
 */
export const SIZES = {
  /**
   * hero plate — 1.1fr of the lg two-column split, full width below it. Loose
   * between 64 and 72rem (painted 502–572), but the source is 1000px wide, so
   * every candidate a tighter hint would pick clamps to the same bytes.
   */
  hero: "(min-width: 64rem) 572px, calc(100vw - 3rem)",
  /** one of three map slices, capped by its own max-w-[168px] */
  mapSlice: "(min-width: 36.5rem) 168px, calc((100vw - 5rem) / 3)",
  /** a three-up step card, capped at h-[265px] × its aspect */
  step: "(min-width: 25.25rem) 306px, calc(100vw - 6rem)",
  /** half of a two-up md: grid, fluid until the container caps */
  half: "(min-width: 72rem) 494px, (min-width: 48rem) calc((100vw - 10.25rem) / 2), calc(100vw - 6rem)",
  /** a roundel, capped at its own max-w-[320px] */
  medallion: "(min-width: 26rem) 320px, calc(100vw - 6rem)",
  /** the well — an lg: two-up, capped at h-[205px] × its aspect */
  well: "(min-width: 36.75rem) 492px, calc(100vw - 6rem)",
  /** the card table — 0.9fr of a full-width plate, capped at h-[242px] × its aspect */
  cardTable: "(min-width: 34.75rem) 460px, calc(100vw - 6rem)",
  /** the pricing pair, which lives inside a max-w-3xl grid with p-7 cards */
  pricing: "(min-width: 51rem) 318px, (min-width: 48rem) calc((100vw - 11.25rem) / 2), calc(100vw - 6.5rem)",
  /** the armillary sphere, drawn at a fixed w-[220px] */
  armillary: "220px",
  /** the mirror, w-[420px] until the section's own padding takes over */
  mirror: "(min-width: 468px) 420px, calc(100vw - 3rem)",
} as const;
