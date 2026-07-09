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
      <div
        role="tablist"
        aria-label="Billing period"
        className="inline-flex items-center gap-1 rounded-lg border border-line bg-night/40 p-0.5"
      >
        {([["monthly", "Monthly"], ["annual", "Annual · save 25%"]] as const).map(([key, label]) => {
          const isAnnual = key === "annual";
          const active = annual === isAnnual;
          return (
            <button
              key={key}
              role="tab"
              aria-selected={active}
              onClick={() => onChange(isAnnual)}
              className={`rounded-md px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors ${
                active ? "bg-electric/15 text-electric" : "text-faint hover:text-mute"
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>
      <p className="mt-3 text-3xl font-semibold text-ink">
        ${price}{" "}
        <span className="text-sm font-normal text-faint">
          / month{annual ? " · billed annually" : ""} · founding price
        </span>
      </p>
    </div>
  );
}
