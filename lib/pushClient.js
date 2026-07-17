// Browser-side push subscription management.
//
// The single most important function here is syncPushSubscription(): iOS can evict a
// push subscription from an unused home-screen app without firing pushsubscriptionchange
// (Safari's support for that event is unreliable), after which push silently stops
// forever. Re-validating on every app open — not the SW event — is what actually fixes it.

import { getSupabase } from "./supabaseClient";

const VAPID_PUBLIC = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

/* ---------------- capability probes ---------------- */

export function isStandalone() {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true // iOS's own, non-standard flag
  );
}

export function isIOS() {
  if (typeof navigator === "undefined") return false;
  // iPadOS 13+ reports as Macintosh; the touch-point check separates it from a real Mac.
  return (
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (/macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
  );
}

export function pushSupported() {
  if (typeof window === "undefined") return false;
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

// iOS only exposes PushManager to an installed app, so pushSupported() is already
// false in a Safari tab. This names *why*, so the UI can show install instructions
// instead of a dead "Enable" button.
export function needsInstallFirst() {
  return isIOS() && !isStandalone();
}

export function permission() {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission; // "default" | "granted" | "denied"
}

/* ---------------- helpers ---------------- */

// Chrome tolerates a raw base64url string for applicationServerKey; Safari and
// Firefox do not. Always pass the Uint8Array.
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// Does this subscription belong to the VAPID key we're currently signing with?
// If not, every send 403s forever with no way back: subscribing still "succeeds", so
// it looks like a delivery problem. Returns true when the browser won't tell us, since
// forcing a resubscribe on every open would be worse than the rare mismatch.
function usesCurrentKey(sub, keyBytes) {
  const current = sub?.options?.applicationServerKey;
  if (!current) return true;
  const bytes = new Uint8Array(current);
  if (bytes.length !== keyBytes.length) return false;
  return bytes.every((b, i) => b === keyBytes[i]);
}

// Reuse the existing subscription only if it matches the current key; otherwise drop it
// and make a new one. This is the only path that can repair a key rotation from the UI.
async function getOrCreateSubscription(reg) {
  if (!VAPID_PUBLIC) throw new Error("NEXT_PUBLIC_VAPID_PUBLIC_KEY is not set");
  const keyBytes = urlBase64ToUint8Array(VAPID_PUBLIC);

  let sub = await reg.pushManager.getSubscription();
  if (sub && !usesCurrentKey(sub, keyBytes)) {
    await sub.unsubscribe().catch(() => {});
    sub = null;
  }
  if (sub) return sub;

  return reg.pushManager.subscribe({
    userVisibleOnly: true, // required; a silent push isn't allowed
    applicationServerKey: keyBytes,
  });
}

async function authHeader() {
  const { data } = await getSupabase().auth.getSession();
  const token = data?.session?.access_token;
  if (!token) throw new Error("Not signed in");
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

export const detectedTimezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

// navigator.serviceWorker.ready never settles when nothing is registered — and we
// deliberately don't register under `next dev`. Without this race the Enable button
// would spin forever with no error. Fail loudly with the actual reason instead.
function swReady(ms = 5000) {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              process.env.NODE_ENV === "production"
                ? "Service worker isn't ready — reload and try again."
                : "No service worker in dev. Run `npm run build && npm run start` to test push."
            )
          ),
        ms
      )
    ),
  ]);
}

async function post(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: await authHeader(),
    body: JSON.stringify(body || {}),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) throw new Error((data && data.error) || `http ${res.status}`);
  return data;
}

/* ---------------- subscription lifecycle ---------------- */

// Must be called from a real user gesture — iOS rejects requestPermission() otherwise,
// and a denial there is permanent and only reversible in OS settings.
export async function enablePush() {
  if (!pushSupported()) throw new Error("Push isn't supported in this browser");
  if (needsInstallFirst()) throw new Error("Add CutCoach to your Home Screen first");
  if (!VAPID_PUBLIC) throw new Error("NEXT_PUBLIC_VAPID_PUBLIC_KEY is not set");

  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error(`Notifications ${perm}`);

  const reg = await swReady();
  const sub = await getOrCreateSubscription(reg);

  await post("/api/push/subscribe", {
    subscription: sub.toJSON(),
    timezone: detectedTimezone(),
  });
  return sub;
}

// Called on every app open. Cheap when nothing has changed, and the only reliable
// guard against a silently-evicted iOS subscription.
export async function syncPushSubscription() {
  if (!pushSupported() || permission() !== "granted") return null;
  try {
    const reg = await swReady();
    // Re-creates the subscription if iOS evicted it, or if it predates a key rotation.
    // Permission is already granted, so this needs no user gesture.
    const sub = await getOrCreateSubscription(reg);
    // Unconditional re-upsert: also refreshes timezone after travel/DST, which would
    // otherwise silently fire reminders at the wrong local time.
    await post("/api/push/subscribe", {
      subscription: sub.toJSON(),
      timezone: detectedTimezone(),
    });
    return sub;
  } catch {
    return null; // never block app boot on this
  }
}

export async function unsubscribePush() {
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => {});
  await post("/api/push/unsubscribe", { endpoint });
}

export async function sendTestPush() {
  return post("/api/push/test", {});
}
