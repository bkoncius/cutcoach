"use client";

import { useEffect, useState } from "react";

export default function ServiceWorkerRegistrar() {
  const [waiting, setWaiting] = useState(null);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    // A service worker under `next dev` fights HMR and serves stale chunks.
    // To exercise it locally: npm run build && npm run start
    if (process.env.NODE_ENV !== "production") return;

    let reg = null;
    let reloading = false;
    // If there's no controller yet this is a first install, and the activate
    // handler's clients.claim() will fire controllerchange. Reloading on that
    // would bounce the page for no reason on every user's first visit.
    const hadController = !!navigator.serviceWorker.controller;

    const onControllerChange = () => {
      if (!hadController || reloading) return;
      reloading = true; // without this, controllerchange → reload → ... loops
      window.location.reload();
    };

    const watch = (r) => {
      if (r.waiting) setWaiting(r.waiting);
      r.addEventListener("updatefound", () => {
        const next = r.installing;
        if (!next) return;
        next.addEventListener("statechange", () => {
          // installed + an existing controller means an update is parked.
          if (next.state === "installed" && navigator.serviceWorker.controller) setWaiting(next);
        });
      });
    };

    // Register after load so the SW install doesn't compete with the first paint.
    const onLoad = () => {
      navigator.serviceWorker
        .register("/sw.js")
        .then((r) => {
          reg = r;
          watch(r);
        })
        .catch((e) => console.error("SW registration failed", e));
    };

    // A phone that's been in a pocket for a week should still pick up deploys.
    const onVisible = () => {
      if (document.visibilityState === "visible" && reg) reg.update().catch(() => {});
    };

    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    document.addEventListener("visibilitychange", onVisible);
    if (document.readyState === "complete") onLoad();
    else window.addEventListener("load", onLoad);

    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("load", onLoad);
    };
  }, []);

  if (!waiting) return null;

  return (
    <button
      onClick={() => {
        waiting.postMessage({ type: "SKIP_WAITING" });
        setWaiting(null); // controllerchange fires next and reloads us
      }}
      className="fixed left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-full bg-amber-400 text-slate-950 text-xs font-semibold shadow-lg shadow-slate-950"
      style={{ bottom: "calc(5.5rem + env(safe-area-inset-bottom))" }}
    >
      Update ready · Reload
    </button>
  );
}
