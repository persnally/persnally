"use client";

// Founding pricing. Annual mirrors Obsidian's monthly-vs-annual discount pattern.
export const MONTHLY = 8;
export const ANNUAL_PER_MONTH = 6;

// Controlled: the parent owns `annual` so the waitlist form can read the same
// selection (and record it as willingness-to-pay signal).
export function PriceToggle({ annual, onChange }: { annual: boolean; onChange: (annual: boolean) => void }) {
  const price = annual ? ANNUAL_PER_MONTH : MONTHLY;
  return (
    <div>
      <div role="tablist" aria-label="Billing period" className="inline-flex items-center gap-4 border-b border-ink/25">
        {([["monthly", "Monthly"], ["annual", "Annual · save 25%"]] as const).map(([key, label]) => {
          const isAnnual = key === "annual";
          const active = annual === isAnnual;
          return (
            <button
              key={key}
              role="tab"
              aria-selected={active}
              onClick={() => onChange(isAnnual)}
              className={`-mb-px border-b-2 px-0.5 pb-1.5 font-mono text-[10px] uppercase tracking-[0.12em] transition-colors ${
                active ? "border-electric text-electric" : "border-transparent text-faint hover:text-mute"
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>
      <p className="font-display mt-3 text-4xl text-ink">
        ${price}{" "}
        <span className="text-base text-faint">
          / month{annual ? " · billed annually" : ""} · founding price
        </span>
      </p>
    </div>
  );
}
