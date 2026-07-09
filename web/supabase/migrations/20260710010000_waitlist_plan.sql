-- Capture which plan the signup picked on the pricing toggle, so waitlist
-- signups double as willingness-to-pay signal (monthly vs annual, at what price).
-- Nullable: an email-only signup (no plan) still succeeds.
alter table public.waitlist
  add column if not exists plan   text    check (plan in ('monthly', 'annual')),
  add column if not exists amount numeric;  -- per-month price shown at signup (8 monthly, 6 annual)
