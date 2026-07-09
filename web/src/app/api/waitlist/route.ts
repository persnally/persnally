import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Requires a `waitlist` table (see PR description for DDL) with an
// insert-only RLS policy — the anon key must not be able to read it back.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_EMAIL_LEN = 254;

export async function POST(request: Request) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    return NextResponse.json(
      { error: "The waitlist isn't open yet — check back soon." },
      { status: 503 }
    );
  }

  let email: unknown, plan: unknown, amount: unknown;
  try {
    ({ email, plan, amount } = await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (typeof email !== "string") {
    return NextResponse.json({ error: "Email is required." }, { status: 400 });
  }
  const normalized = email.trim().toLowerCase();
  if (normalized.length > MAX_EMAIL_LEN || !EMAIL_RE.test(normalized)) {
    return NextResponse.json({ error: "That doesn't look like an email address." }, { status: 400 });
  }

  // Plan + amount are the WTP signal, not user-facing input — accept only the
  // known values and ignore anything malformed rather than rejecting the signup.
  const row: { email: string; plan?: string; amount?: number } = { email: normalized };
  if (plan === "monthly" || plan === "annual") row.plan = plan;
  if (typeof amount === "number" && Number.isFinite(amount) && amount >= 0 && amount <= 1000) row.amount = amount;

  const supabase = createClient(url, anonKey, { auth: { persistSession: false } });
  const { error } = await supabase.from("waitlist").insert(row);

  // 23505 = unique violation: already on the list — success for the user.
  if (error && error.code !== "23505") {
    console.error("waitlist insert failed:", error.code, error.message);
    return NextResponse.json(
      { error: "Couldn't save your email — please try again." },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true });
}
