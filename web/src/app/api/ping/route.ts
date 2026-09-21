import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// The opt-in funnel ping from `persnally metrics on`. Requires a `pings` table
// (see PR description for DDL) with an insert-only RLS policy. The row is the
// request body plus a server timestamp — no IP, no user agent, nothing else.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION_RE = /^\d+\.\d+\.\d+[0-9A-Za-z.+-]{0,20}$/;
const STAGES = ["installed", "activated", "returned", "week2"];

export async function POST(request: Request) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return NextResponse.json({ error: "Not configured." }, { status: 503 });

  let id: unknown, stage: unknown, v: unknown;
  try {
    ({ id, stage, v } = await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  if (typeof id !== "string" || !UUID_RE.test(id)
    || typeof stage !== "string" || !STAGES.includes(stage)
    || typeof v !== "string" || !VERSION_RE.test(v)) {
    return NextResponse.json({ error: "Invalid ping." }, { status: 400 });
  }

  const supabase = createClient(url, anonKey, { auth: { persistSession: false } });
  const { error } = await supabase.from("pings").insert({ install_id: id.toLowerCase(), stage, version: v });

  // 23505 = this install already reported this stage — success for the client, which then stops retrying.
  if (error && error.code !== "23505") {
    console.error("ping insert failed:", error.code, error.message);
    return NextResponse.json({ error: "Not saved." }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
