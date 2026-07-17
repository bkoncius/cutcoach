/* CutCoach service worker — hand-rolled, no workbox.
 *
 * The app is a single route with in-memory tabs, so there is exactly one HTML
 * document to cache and /_next/static/* is content-hashed and immutable. That
 * makes a build-time precache manifest (next-pwa / serwist) machinery we don't
 * need, and it leaves the push handlers fully under our control.
 *
 * Bump CACHE_VERSION to drop the old shell cache on next activate.
 */

const CACHE_VERSION = "v1";
const CACHE = `cutcoach-${CACHE_VERSION}`;

const SHELL = [
  "/",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon-180.png",
  "/icons/badge-72.png",
];

/* ---------------- lifecycle ---------------- */

self.addEventListener("install", (event) => {
  // Deliberately no skipWaiting(). A new SW that claims a page still running the
  // previous build's JS would field requests for old content-hashed chunks that
  // its fresh cache lacks and the CDN may 404 — a white screen mid-session.
  // The page shows an "Update ready" pill and posts SKIP_WAITING when the user opts in.
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .catch(() => {}) // a failed precache must not block install
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

/* ---------------- fetch ---------------- */

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Only ever claim requests we explicitly own. Never call respondWith()
  // speculatively — a handler that claims a request and then throws breaks
  // every request on the origin, not just the one it mishandled.
  if (req.method !== "GET") return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }

  // One line that excludes Supabase and Anthropic. This is a security control,
  // not just a correctness one: caching those responses would persist another
  // user's ledger — and their auth tokens — in CacheStorage after sign-out.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  // Never let an RSC payload be served for a document request (renders blank).
  if (url.searchParams.has("_rsc") || req.headers.get("RSC")) return;

  if (req.mode === "navigate") {
    event.respondWith(navigateNetworkFirst(req));
    return;
  }

  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(cacheFirst(req));
  }
});

// Network-first for the document. This — not the static-chunk cache — is what
// makes offline actually work: without a cached HTML shell an offline cold start
// hits the browser's network-error page and never boots far enough to use the
// chunks we cached.
async function navigateNetworkFirst(req) {
  try {
    const res = await fetch(req);
    if (res && res.ok) {
      const cache = await caches.open(CACHE);
      // Always store under "/" — every URL on this origin serves the same shell
      // (tabs are client state), so ?tab=coach must not get its own entry.
      cache.put("/", res.clone());
    }
    return res;
  } catch {
    const cached = (await caches.match("/")) || (await caches.match(req));
    if (cached) return cached;
    throw new Error("offline, no cached shell");
  }
}

// Safe as cache-first because these URLs are content-hashed: a changed file is a
// changed URL, so an entry can never go stale.
async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && res.ok) {
      const cache = await caches.open(CACHE);
      cache.put(req, res.clone());
    }
    return res;
  } catch {
    return Response.error();
  }
}

/* ---------------- push ---------------- */

self.addEventListener("push", (event) => {
  // Always show a notification, even for a malformed payload. Chrome shows
  // "This site has been updated in the background" for a push that doesn't
  // produce one, and can revoke the permission if it keeps happening.
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }

  const title = data.title || "CutCoach";
  const tab = data.tab || "today";

  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-72.png",
      // One tag per reminder kind, so a re-send replaces rather than stacks.
      tag: data.tag || "cutcoach",
      renotify: true,
      data: { tab },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const tab = (event.notification.data && event.notification.data.tab) || "today";

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of clientList) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        // focus + postMessage beats client.navigate(), which forces a full reload.
        await client.focus();
        client.postMessage({ type: "NAVIGATE_TAB", tab });
        return;
      }
      await self.clients.openWindow(`/?tab=${tab}`);
    })()
  );
});

self.addEventListener("pushsubscriptionchange", (event) => {
  // Best-effort, and deliberately local-only: a service worker cannot read the
  // Supabase session (it lives in localStorage, which SWs have no access to), so
  // it cannot authenticate a POST to /api/push/subscribe. Re-subscribing here just
  // keeps a valid subscription in place; the server learns about it when the app
  // next opens and syncPushSubscription() re-upserts it. That client-side re-sync
  // — not this handler — is the real fix for iOS silently evicting subscriptions.
  event.waitUntil(
    (async () => {
      try {
        const key =
          event.oldSubscription &&
          event.oldSubscription.options &&
          event.oldSubscription.options.applicationServerKey;
        if (!key) return;
        await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: key,
        });
      } catch {
        // Nothing useful to do here — the next app open reconciles.
      }
    })()
  );
});
