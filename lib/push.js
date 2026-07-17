import "server-only";
import webpush from "web-push";
import { getSupabaseAdmin } from "./supabaseAdmin";

let configured = false;

function configure() {
  if (configured) return;
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) {
    throw new Error(
      "VAPID env vars missing. Set NEXT_PUBLIC_VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT."
    );
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
}

const toSubscription = (row) => ({
  endpoint: row.endpoint,
  keys: { p256dh: row.p256dh, auth: row.auth },
});

/**
 * Send one payload to every device a user has registered.
 *
 * ttlSeconds defaults to an hour because web-push's own default is FOUR WEEKS — a
 * weigh-in reminder resurfacing three days later is worse than not sending it. Pass
 * the reminder's remaining useful life.
 *
 * -> [{ endpoint, ok, status?, error?, pruned? }]
 */
export async function sendToUser(userId, payload, ttlSeconds = 3600) {
  configure();
  const admin = getSupabaseAdmin();

  const { data: subs, error } = await admin
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("user_id", userId);
  if (error) throw error;
  if (!subs || subs.length === 0) return [];

  const body = JSON.stringify(payload);

  return Promise.all(
    subs.map(async (row) => {
      const short = `${row.endpoint.slice(0, 40)}…`;
      try {
        await webpush.sendNotification(toSubscription(row), body, { TTL: ttlSeconds });
        await admin
          .from("push_subscriptions")
          .update({ last_seen_at: new Date().toISOString(), last_error: null })
          .eq("id", row.id);
        return { endpoint: short, ok: true };
      } catch (e) {
        const status = e?.statusCode || 0;

        // 404/410 mean the push service has permanently dropped this subscription.
        // Nothing will ever reach it again, so delete rather than accumulate corpses.
        if (status === 404 || status === 410) {
          await admin.from("push_subscriptions").delete().eq("id", row.id);
          return { endpoint: short, ok: false, status, pruned: true };
        }

        // 403 is almost always a VAPID key mismatch: subscribing succeeded under one
        // key pair and we're now signing with another. It will never recover on its
        // own and there's no migration path — every device must resubscribe. Surface
        // the body, which is the only place the real reason appears.
        const detail = e?.body ? String(e.body).slice(0, 300) : e?.message || "send failed";
        await admin
          .from("push_subscriptions")
          .update({ last_error: `${status}: ${detail}`.slice(0, 500) })
          .eq("id", row.id);
        return { endpoint: short, ok: false, status, error: detail };
      }
    })
  );
}
