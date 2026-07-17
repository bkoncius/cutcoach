import { requireUser } from "../../../../lib/serverAuth";
import { getSupabaseAdmin } from "../../../../lib/supabaseAdmin";

export const runtime = "nodejs";

// POST { endpoint }
export async function POST(req) {
  const { user, error } = await requireUser(req);
  if (error) return error;

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const endpoint = body?.endpoint;
  if (!endpoint) return Response.json({ error: "endpoint required" }, { status: 400 });

  // Scoped to the caller as well as the endpoint: possession of an endpoint string
  // must not be enough to unregister someone else's device.
  const { error: delErr } = await getSupabaseAdmin()
    .from("push_subscriptions")
    .delete()
    .eq("endpoint", endpoint)
    .eq("user_id", user.id);
  if (delErr) return Response.json({ error: delErr.message }, { status: 500 });

  return Response.json({ ok: true });
}
