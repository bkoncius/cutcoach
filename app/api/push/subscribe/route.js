import { requireUser } from "../../../../lib/serverAuth";
import { getSupabaseAdmin } from "../../../../lib/supabaseAdmin";

export const runtime = "nodejs";

// POST { subscription, timezone }
//
// Takes both together on purpose: it guarantees profiles.timezone is non-null for
// anyone who could possibly receive a push, so the dispatcher's "no timezone" branch
// is unreachable by construction rather than a silent hole where reminders vanish.
export async function POST(req) {
  const { user, error } = await requireUser(req);
  if (error) return error;

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const sub = body?.subscription;
  const endpoint = sub?.endpoint;
  const p256dh = sub?.keys?.p256dh;
  const auth = sub?.keys?.auth;
  if (!endpoint || !p256dh || !auth) {
    return Response.json({ error: "subscription {endpoint, keys:{p256dh, auth}} required" }, { status: 400 });
  }

  const admin = getSupabaseAdmin();

  // onConflict endpoint, not (user_id, endpoint): if this device previously belonged
  // to another account, the row must move to the current user rather than duplicate —
  // otherwise the previous user's reminders keep arriving on this lock screen. RLS
  // would block that update through the anon client, hence the service-role client.
  const { error: subErr } = await admin.from("push_subscriptions").upsert(
    {
      user_id: user.id,
      endpoint,
      p256dh,
      auth,
      user_agent: (req.headers.get("user-agent") || "").slice(0, 300),
      last_seen_at: new Date().toISOString(),
      last_error: null,
    },
    { onConflict: "endpoint" }
  );
  if (subErr) return Response.json({ error: subErr.message }, { status: 500 });

  const timezone = typeof body?.timezone === "string" ? body.timezone : null;
  if (timezone) {
    // Narrow writer: touches only timezone, never phase/targets. saveProfile() owns
    // those, and neither can clobber the other's columns.
    const { error: tzErr } = await admin
      .from("profiles")
      .upsert({ user_id: user.id, timezone, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
    if (tzErr) return Response.json({ error: tzErr.message }, { status: 500 });
  }

  const { count } = await admin
    .from("push_subscriptions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id);

  return Response.json({ ok: true, devices: count ?? 1, timezone });
}
