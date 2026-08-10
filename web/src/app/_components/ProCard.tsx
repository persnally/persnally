"use client";

import Image from "next/image";
import { useState } from "react";
import { Check } from "lucide-react";
import { ANNUAL_PER_MONTH, MONTHLY, PriceToggle } from "./PriceToggle";
import { WaitlistForm } from "./WaitlistForm";
import { SIZES } from "../_sizes";
import keyPlate from "../_art/key.webp";

// Each line says which side of the custody line it sits on. The section's
// CustodyNote spells out why inference can't be ciphertext-only.
const PRO = [
  "Encrypted backup & restore of your accumulated self — ciphertext, we hold no key",
  "Agent relay — your phone and cloud agents reach your context, end-to-end encrypted",
  "Zero-setup inference — no API key needed (fair-use). Processed in the clear, never stored",
  "Reflection reports — what changed about you, over time",
];

// Owns the monthly/annual selection so the price toggle and the waitlist form
// share it — the chosen plan + price ride along on the signup (WTP signal).
export function ProCard() {
  const [annual, setAnnual] = useState(true);
  const plan = annual ? "annual" : "monthly";
  const amount = annual ? ANNUAL_PER_MONTH : MONTHLY;

  return (
    <div className="plate flex flex-col p-7">
      <div className="flex items-center justify-between">
        <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-electric">Pro</p>
        <span className="border border-electric/40 px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-electric">
          Coming soon
        </span>
      </div>
      <div className="mt-3">
        <PriceToggle annual={annual} onChange={setAnnual} />
      </div>
      <figure className="mt-5">
        <Image
          src={keyPlate}
          alt=""
          aria-hidden
          sizes={SIZES.pricing}
          className="h-auto w-full mix-blend-multiply"
        />
        <figcaption className="mt-2 text-center font-mono text-[10px] uppercase tracking-[0.12em] text-faint">
          the key — yours alone · backup &amp; relay stay ciphertext
        </figcaption>
      </figure>
      <ul className="mt-6 space-y-3.5">
        {PRO.map((x) => (
          <li key={x} className="flex items-start gap-3 text-[15px] text-ink">
            <Check className="mt-0.5 size-4 shrink-0 text-electric" strokeWidth={2.25} />
            {x}
          </li>
        ))}
      </ul>
      <div className="mt-auto pt-7">
        <WaitlistForm plan={plan} amount={amount} />
      </div>
    </div>
  );
}
