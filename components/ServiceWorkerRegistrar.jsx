"use client";

import { useEffect, useRef, useState } from "react";

const BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID || "dev";
const VERSION_POLL_MS = 20 * 60 * 1000; // long-open sessions
// After an app-only update reload, ignore the version check briefly so a transient CDN
// skew (new /api/version but momentarily stale HTML) can't bounce us into a loop.
const SUPPRESS_AFTER_RELOAD_MS = 10 * 1000;

export default function ServiceWorkerRegistrar() {
  // A waiting SW means sw.js itself changed (rare). A version mismatch means an ordinary
  // app-only deploy (common). Either one surfaces the same popup.
  const [waiting, setWaiting] = useState(null);
  const [newVersion, setNewVersion] = useState(false);
  const [dismissed, setDismissed] = useState(false); // "Later" → collapse to the pill
  // Set when the user clicks "Update now" for a waiting worker. It lets the reload happen
  // even in a session that began with no controller — where hadController alone would
  // suppress it and the click would appear to do nothing.
  const userRequestedReload = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    // A newer build's HTML replaced ours after an update reload — this is expected, not
    // a fresh mismatch. Skip the first check so we don't immediately re-prompt. Guarded:
    // storage access throws in some privacy modes, and this must not take down SW
    // registration below with it.
    let suppressUntil = 0;
    try {
      if (sessionStorage.getItem("cutcoach:updating")) {
        sessionStorage.removeItem("cutcoach:updating");
        suppressUntil = Date.now() + SUPPRESS_AFTER_RELOAD_MS;
      }
    } catch {
      /* no suppression window — the version match after reload still prevents a loop */
    }

    const checkVersion = async () => {
      if (Date.now() < suppressUntil) return;
      if (BUILD_ID === "dev") return; // no meaningful id to compare in dev
      try {
        const res = await fetch("/api/version", { cache: "no-store" });
        if (!res.ok) return;
        const { buildId } = await res.json();
        if (buildId && buildId !== "dev" && buildId !== BUILD_ID) setNewVersion(true);
      } catch {
        // Offline or transient — no prompt.
      }
    };

    // The version poll runs regardless of service-worker support; a browser without SWs
    // still gets the update prompt on a new deploy.
    const onVisibleVersion = () => {
      if (document.visibilityState === "visible") checkVersion();
    };
    document.addEventListener("visibilitychange", onVisibleVersion);
    const interval = setInterval(checkVersion, VERSION_POLL_MS);
    checkVersion();

    const hasSW = "serviceWorker" in navigator;
    // The SW itself only registers in production (it fights HMR under next dev), but the
    // version poll above is useful in any production-like build.
    const swEnabled = hasSW && process.env.NODE_ENV === "production";

    let reg = null;
    let reloading = false;
    // No controller yet = first install; the activate handler's clients.claim() will fire
    // controllerchange, and reloading on that would bounce every user's first visit.
    const hadController = hasSW && !!navigator.serviceWorker.controller;

    const onControllerChange = () => {
      if (reloading) return;
      // hadController suppresses the first-install controllerchange (clients.claim), which
      // isn't a user action. But an explicit "Update now" must always reload, even in a
      // session that started without a controller.
      if (!hadController && !userRequestedReload.current) return;
      reloading = true; // without this, controllerchange → reload → … loops
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

    // Register after load so the SW install doesn't compete with first paint.
    const onLoad = () => {
      navigator.serviceWorker
        .register("/sw.js")
        .then((r) => {
          reg = r;
          watch(r);
        })
        .catch((e) => console.error("SW registration failed", e));
    };

    const onVisibleSW = () => {
      if (document.visibilityState === "visible" && reg) reg.update().catch(() => {});
    };

    if (swEnabled) {
      navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
      document.addEventListener("visibilitychange", onVisibleSW);
      if (document.readyState === "complete") onLoad();
      else window.addEventListener("load", onLoad);
    }

    return () => {
      document.removeEventListener("visibilitychange", onVisibleVersion);
      clearInterval(interval);
      if (swEnabled) {
        navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
        document.removeEventListener("visibilitychange", onVisibleSW);
        window.removeEventListener("load", onLoad);
      }
    };
  }, []);

  const available = waiting || newVersion;
  const modalOpen = available && !dismissed;

  // Esc dismisses the modal to the pill, matching the backdrop click.
  useEffect(() => {
    if (!modalOpen) return;
    const onKey = (e) => {
      if (e.key === "Escape") setDismissed(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [modalOpen]);

  if (!available) return null;

  const applyUpdate = () => {
    if (waiting) {
      // sw.js changed: hand off to the waiting worker; controllerchange then reloads once.
      userRequestedReload.current = true;
      waiting.postMessage({ type: "SKIP_WAITING" });
      setWaiting(null);
      return;
    }
    // App-only deploy: no waiting worker to swap. A plain reload is enough — the SW serves
    // navigations network-first, so it fetches the new HTML and its fresh chunk URLs.
    // The flag lets the reloaded page skip its first version check (loop insurance).
    try {
      sessionStorage.setItem("cutcoach:updating", "1");
    } catch {
      /* private mode — the reload still works, we just don't get the suppression */
    }
    window.location.reload();
  };

  // "Later" collapses the modal to a non-blocking pill so someone mid-workout isn't
  // forced to choose. The pill stays until they update.
  if (dismissed) {
    return (
      <button
        onClick={() => setDismissed(false)}
        className="fixed left-1/2 -translate-x-1/2 z-[60] px-4 py-2 rounded-full bg-amber-400 text-slate-950 text-xs font-semibold shadow-lg shadow-slate-950"
        style={{ bottom: "calc(5.5rem + env(safe-area-inset-bottom))" }}
      >
        Update available
      </button>
    );
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6"
      onClick={() => setDismissed(true)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-xl shadow-slate-950"
        style={{ marginBottom: "env(safe-area-inset-bottom)" }}
      >
        <h2 id="update-title" className="text-lg font-bold text-slate-100">
          A new version is available
        </h2>
        <p className="mt-2 text-sm text-slate-400 leading-relaxed">
          Update now to reload with the latest. Finish anything in progress first — reloading
          restarts the app.
        </p>
        <button
          autoFocus
          onClick={applyUpdate}
          className="mt-4 w-full py-2.5 rounded-xl bg-amber-400 text-slate-950 text-sm font-semibold"
        >
          Update now
        </button>
        <button
          onClick={() => setDismissed(true)}
          className="mt-2 w-full py-2 rounded-xl text-xs text-slate-400 border border-slate-800"
        >
          Later
        </button>
      </div>
    </div>
  );
}
