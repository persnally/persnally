-- Waitlist capture for the Pro tier. Insert-only for the public anon role:
-- the browser-visible anon key can add a signup but can NEVER read the list
-- back (no SELECT policy), so the email list can't leak from the client.
create table if not exists public.waitlist (
  id         bigint generated always as identity primary key,
  email      text not null unique check (char_length(email) <= 254),
  created_at timestamptz not null default now()
);

alter table public.waitlist enable row level security;

-- Anyone may join; a duplicate email hits the unique constraint (23505),
-- which the API route treats as success ("already on the list").
drop policy if exists "anon can join" on public.waitlist;
create policy "anon can join" on public.waitlist
  for insert to anon
  with check (true);

-- Deliberately NO select/update/delete policy for anon — the list is
-- readable only via the service_role key (dashboard / server), never the
-- public key shipped to the browser.
