import "server-only";
import { createClient } from "@supabase/supabase-js";

// Verifies the caller's Supabase JWT. Extracted from app/api/ai/route.js so every
// user-facing route authenticates the same way.
// -> { user } on success, { error: Response } on failure.
export async function requireUser(req) {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) {
    return { error: Response.json({ error: { message: "Missing auth token" } }, { status: 401 }) };
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    return { error: Response.json({ error: { message: "Unauthorized" } }, { status: 401 }) };
  }
  return { user: data.user };
}

// Guards the cron dispatch endpoint. Scheduler-agnostic by design: Vercel Cron sends
// `Authorization: Bearer $CRON_SECRET` automatically, and the pg_cron + pg_net job in
// supabase/003_cron.sql sends a byte-identical header. Swapping schedulers needs no
// code change here.
export function requireCron(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return { error: Response.json({ error: "CRON_SECRET is not set" }, { status: 500 }) };
  }
  const got = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (got !== secret) {
    return { error: Response.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  return {};
}
