import { requireUser } from "../../../../lib/serverAuth";
import { sendToUser } from "../../../../lib/push";

export const runtime = "nodejs";

// POST -> send a real push to every device the caller has registered.
//
// This is the diagnostic that matters: you cannot attach a debugger to an installed
// iOS PWA from Windows, so the per-endpoint results this returns are the only visibility
// into why a send failed. Deliberately verbose.
export async function POST(req) {
  const { user, error } = await requireUser(req);
  if (error) return error;

  try {
    const results = await sendToUser(
      user.id,
      {
        title: "CutCoach test",
        body: "Push is working. Reminders will look like this.",
        tag: "cutcoach-test",
        tab: "today",
      },
      60 // a test that surfaces an hour later is just confusing
    );

    if (results.length === 0) {
      return Response.json(
        { ok: false, devices: 0, error: "No registered devices — enable notifications first." },
        { status: 409 }
      );
    }
    return Response.json({ ok: results.some((r) => r.ok), devices: results.length, results });
  } catch (e) {
    return Response.json({ ok: false, error: e?.message || "send failed" }, { status: 500 });
  }
}
