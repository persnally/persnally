/** The Persnally eye mark (brand variant) — inline so the single-file build
    carries it with no asset pipeline. Source: web/public/brand/persnally-mark-eye-brand.svg */
export function Mark() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none" aria-hidden="true">
      <path fill="currentColor" d="M 8,50 Q 50,22 92,50 Q 50,66 8,50 Z" />
      <circle cx="36" cy="54" r="9" fill="var(--brand)" />
    </svg>
  );
}
