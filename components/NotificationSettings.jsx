"use client";

import { useState, useEffect, useCallback } from "react";
import { Bell, Check, Share, ChevronDown, Download } from "lucide-react";
import { REMINDERS, DEFAULT_REMINDERS } from "../lib/reminders";
import { saveReminders } from "../lib/db";
import { Card, Eyebrow } from "./ui";
import {
  enablePush,
  sendTestPush,
  permission,
  pushSupported,
  needsInstallFirst,
  isStandalone,
  isIOS,
  detectedTimezone,
} from "../lib/pushClient";

function Row({ label, children }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <div className="text-sm text-slate-300">{label}</div>
      {children}
    </div>
  );
}

function Toggle({ on, onChange }) {
  return (
    <button
      onClick={() => onChange(!on)}
      role="switch"
      aria-checked={on}
      className={`w-11 h-6 rounded-full p-0.5 transition-colors ${on ? "bg-amber-400" : "bg-slate-700"}`}
    >
      <div
        className={`w-5 h-5 rounded-full bg-slate-950 transition-transform ${on ? "translate-x-5" : ""}`}
      />
    </button>
  );
}

export default function NotificationSettings({ settings, onSaved }) {
  // Own draft state and own writer. Reminders never travel through persistSettings(),
  // which would rewrite phase/targets from whatever the other panel holds in memory.
  // This initializer only runs on mount, and the card unmounts whenever the settings
  // sheet closes — so every save must push the value back up via onSaved(), or
  // reopening the sheet would re-seed from a stale prop and show the old toggles.
  const [reminders, setReminders] = useState(() => ({
    ...DEFAULT_REMINDERS,
    ...(settings.reminders || {}),
  }));
  const [perm, setPerm] = useState("default");
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState(null); // { kind: "ok"|"err", text }
  const [saved, setSaved] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [debug, setDebug] = useState({});
  const [installEvent, setInstallEvent] = useState(null);

  const tz = detectedTimezone();
  const tzDrift = settings.timezone && settings.timezone !== tz;

  const refreshDebug = useCallback(async () => {
    const next = {
      permission: typeof Notification !== "undefined" ? Notification.permission : "unsupported",
      supported: pushSupported(),
      standalone: isStandalone(),
      ios: isIOS(),
      detectedTz: tz,
      storedTz: settings.timezone || "—",
      swController: typeof navigator !== "undefined" && !!navigator.serviceWorker?.controller,
      vapidKeySet: !!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
      buildId: process.env.NEXT_PUBLIC_BUILD_ID || "—",
      endpoint: "—",
    };
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      const sub = reg && (await reg.pushManager.getSubscription());
      if (sub) next.endpoint = `${sub.endpoint.slice(0, 48)}…`;
    } catch {
      /* leave as — */
    }
    setDebug(next);
  }, [settings.timezone, tz]);

  useEffect(() => {
    setPerm(permission());
    refreshDebug();
  }, [refreshDebug]);

  useEffect(() => {
    // Fires once and only once. Stash it or you can never prompt to install later.
    const onPrompt = (e) => {
      e.preventDefault();
      setInstallEvent(e);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  const update = (id, patch) => {
    const next = { ...reminders, [id]: { ...reminders[id], ...patch } };
    setReminders(next);
    setSaved(false);
  };

  const save = async () => {
    setBusy("save");
    setMsg(null);
    try {
      await saveReminders(tz, reminders);
      onSaved?.(tz, reminders);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setMsg({ kind: "err", text: e?.message || "Couldn't save reminders" });
    }
    setBusy("");
  };

  const onEnable = async () => {
    setBusy("enable");
    setMsg(null);
    try {
      await enablePush();
      setPerm(permission());
      // Enabling without saving would leave reminders at '{}' server-side and nothing
      // would ever fire — the one place the fail-closed default is a footgun.
      await saveReminders(tz, reminders);
      onSaved?.(tz, reminders);
      setMsg({ kind: "ok", text: "Notifications on. Send a test to confirm." });
    } catch (e) {
      setPerm(permission());
      setMsg({ kind: "err", text: e?.message || "Couldn't enable notifications" });
    }
    await refreshDebug();
    setBusy("");
  };

  const onTest = async () => {
    setBusy("test");
    setMsg(null);
    try {
      const res = await sendTestPush();
      const failed = (res.results || []).filter((r) => !r.ok);
      if (failed.length) {
        setMsg({ kind: "err", text: `${failed.length}/${res.devices} failed: ${failed[0].error || failed[0].status}` });
      } else {
        setMsg({ kind: "ok", text: `Sent to ${res.devices} device${res.devices === 1 ? "" : "s"}.` });
      }
      setDebug((d) => ({ ...d, lastTest: JSON.stringify(res) }));
    } catch (e) {
      setMsg({ kind: "err", text: e?.message || "Test failed" });
      setDebug((d) => ({ ...d, lastTest: String(e?.message) }));
    }
    setBusy("");
  };

  const onInstall = async () => {
    if (!installEvent) return;
    installEvent.prompt();
    await installEvent.userChoice;
    setInstallEvent(null);
  };

  const iosNeedsInstall = needsInstallFirst();

  return (
    <Card>
      <div className="flex items-center gap-2">
        <Bell size={14} className="text-amber-400" />
        <Eyebrow color="text-amber-400">Reminders</Eyebrow>
      </div>

      {/* Gate 1: iOS only exposes push to an installed app. requestPermission() is a
          no-op in a Safari tab, so offer the install path instead of a dead button. */}
      {iosNeedsInstall ? (
        <div className="mt-3 rounded-xl border border-slate-700 bg-slate-800 p-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-200">
            <Share size={14} className="text-teal-400" />
            Add to Home Screen first
          </div>
          <div className="text-xs text-slate-400 mt-2 leading-relaxed">
            iOS only delivers notifications to an installed app. Tap the Share button in
            Safari, choose <span className="text-slate-200">Add to Home Screen</span>, then
            open CutCoach from your home screen and come back here.
          </div>
        </div>
      ) : !pushSupported() ? (
        <div className="mt-3 text-xs text-slate-500 leading-relaxed">
          This browser doesn't support push notifications.
        </div>
      ) : perm === "denied" ? (
        <div className="mt-3 text-xs text-rose-400 leading-relaxed">
          Notifications are blocked. The browser won't let the app ask again — re-enable
          them for CutCoach in your {isIOS() ? "iOS Settings → Notifications" : "browser site settings"}.
        </div>
      ) : perm !== "granted" ? (
        <>
          <div className="text-xs text-slate-500 mt-2 leading-relaxed">
            Nudges only when something's actually outstanding — never if you've already
            weighed in or checked in.
          </div>
          <button
            onClick={onEnable}
            disabled={busy === "enable"}
            className="mt-3 w-full py-2 rounded-xl bg-amber-400 text-slate-950 text-sm font-semibold disabled:opacity-50"
          >
            {busy === "enable" ? "Asking…" : "Enable notifications"}
          </button>
        </>
      ) : (
        <div className="flex items-center gap-2 text-xs text-teal-400 mt-2">
          <Check size={14} /> Notifications on
        </div>
      )}

      {/* Android/desktop only — iOS never fires beforeinstallprompt. */}
      {installEvent && !isStandalone() && (
        <button
          onClick={onInstall}
          className="mt-2 w-full py-2 rounded-xl bg-slate-800 border border-slate-700 text-sm font-semibold flex items-center justify-center gap-2"
        >
          <Download size={14} /> Install CutCoach
        </button>
      )}

      <div className="mt-4 divide-y divide-slate-800">
        {REMINDERS.map((r) => {
          const cfg = reminders[r.id] || r.defaults;
          return (
            <div key={r.id} className="py-1">
              <Row label={r.label}>
                <div className="flex items-center gap-2">
                  <input
                    type="time"
                    step="300"
                    value={cfg.time}
                    onChange={(e) => update(r.id, { time: e.target.value })}
                    className="bg-slate-800 rounded-lg px-2 py-1 font-mono text-xs border border-slate-700 outline-none focus:border-amber-400"
                  />
                  <Toggle on={!!cfg.enabled} onChange={(v) => update(r.id, { enabled: v })} />
                </div>
              </Row>
              <div className="text-xs text-slate-600 pb-2 leading-relaxed">{r.hint}</div>
            </div>
          );
        })}
      </div>

      <div className="text-xs text-slate-500 mt-3 font-mono">
        {tz}
        {tzDrift && <span className="text-amber-400"> · was {settings.timezone}, saving updates it</span>}
      </div>

      <button
        onClick={save}
        disabled={busy === "save"}
        className="mt-3 w-full py-2 rounded-xl bg-slate-800 text-sm font-semibold border border-slate-700 disabled:opacity-50"
      >
        {saved ? "Saved ✓" : busy === "save" ? "Saving…" : "Save reminders"}
      </button>

      {perm === "granted" && (
        <button
          onClick={onTest}
          disabled={busy === "test"}
          className="mt-2 w-full py-2 rounded-xl text-xs text-slate-400 border border-slate-800 disabled:opacity-50"
        >
          {busy === "test" ? "Sending…" : "Send test notification"}
        </button>
      )}

      {msg && (
        <div className={`text-xs mt-2 leading-relaxed ${msg.kind === "ok" ? "text-teal-400" : "text-rose-400"}`}>
          {msg.text}
        </div>
      )}

      {/* Not polish. Safari Web Inspector needs a Mac and you cannot attach any debugger
          to an installed iOS PWA from Windows — for iOS push bugs this panel is the
          entire toolkit. */}
      <button
        onClick={() => {
          setShowDebug((v) => !v);
          if (!showDebug) refreshDebug();
        }}
        className="mt-3 w-full flex items-center justify-center gap-1 text-xs text-slate-600"
      >
        <ChevronDown size={12} className={showDebug ? "rotate-180" : ""} /> Diagnostics
      </button>
      {showDebug && (
        <pre className="mt-2 text-[10px] leading-relaxed text-slate-500 bg-slate-950 border border-slate-800 rounded-lg p-2 overflow-x-auto whitespace-pre-wrap break-all">
          {Object.entries(debug)
            .map(([k, v]) => `${k}: ${v}`)
            .join("\n")}
        </pre>
      )}
    </Card>
  );
}
