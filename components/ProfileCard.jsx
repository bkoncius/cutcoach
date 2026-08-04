"use client";

import { useState } from "react";
import { UserRound } from "lucide-react";
import { Card, Eyebrow } from "./ui";
import { ACTIVITY_LEVELS } from "../lib/calc";
import { formatWeight, cmToFtIn, ftInToCm } from "../lib/units";
import { saveIdentity } from "../lib/db";

/* Settings sibling card for identity fields — same pattern as NotificationSettings:
   own draft state, own narrow writer (saveIdentity never touches targets), value
   pushed back up via onSaved because the card unmounts when the sheet closes. */

const selectCls =
  "w-full bg-slate-800 rounded-lg px-3 py-2 text-sm border border-slate-700 outline-none focus:border-amber-400";

function Row({ label, children }) {
  return (
    <div>
      <div className="text-xs text-slate-500 mb-1">{label}</div>
      {children}
    </div>
  );
}

export default function ProfileCard({ settings, onSaved }) {
  const [d, setD] = useState({
    displayName: settings.displayName || "",
    sex: settings.sex || "unspecified",
    birthdate: settings.birthdate || "",
    heightCm: settings.heightCm || null,
    activityLevel: settings.activityLevel || "moderate",
    experience: settings.experience || "intermediate",
    equipment: settings.equipment || "gym",
    daysPerWeek: settings.daysPerWeek || 4,
    units: settings.units || "metric",
    bodyfatPct: settings.bodyfatPct != null ? String(settings.bodyfatPct) : "",
  });
  const [heightDraft, setHeightDraft] = useState(d.heightCm ? String(Math.round(d.heightCm)) : "");
  const [ftDraft, setFtDraft] = useState(d.heightCm ? String(cmToFtIn(d.heightCm).ft) : "");
  const [inDraft, setInDraft] = useState(d.heightCm ? String(cmToFtIn(d.heightCm).inch) : "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const upd = (k, v) => setD((x) => ({ ...x, [k]: v }));

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const bodyfatPct = d.bodyfatPct.trim() === "" ? null : parseFloat(d.bodyfatPct.replace(",", "."));
      const payload = { ...d, bodyfatPct, displayName: d.displayName.trim() || null };
      await saveIdentity(payload);
      onSaved?.(payload);
      setMsg({ ok: true, text: "Saved" });
      setTimeout(() => setMsg(null), 1500);
    } catch (e) {
      setMsg({ ok: false, text: e?.message || "Couldn't save" });
    }
    setBusy(false);
  };

  return (
    <Card>
      <div className="flex items-center gap-2">
        <UserRound size={14} className="text-amber-400" />
        <Eyebrow color="text-amber-400">Profile</Eyebrow>
      </div>

      <div className="mt-3 space-y-3">
        <Row label="Name">
          <input value={d.displayName} onChange={(e) => upd("displayName", e.target.value)} className={selectCls} />
        </Row>
        <div className="grid grid-cols-2 gap-2">
          <Row label="Sex (for calorie math)">
            <select value={d.sex} onChange={(e) => upd("sex", e.target.value)} className={selectCls}>
              <option value="male">Male</option>
              <option value="female">Female</option>
              <option value="unspecified">Prefer not to say</option>
            </select>
          </Row>
          <Row label="Birthdate">
            <input type="date" value={d.birthdate} onChange={(e) => upd("birthdate", e.target.value)} className={selectCls} />
          </Row>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Row label="Units">
            <select value={d.units} onChange={(e) => upd("units", e.target.value)} className={selectCls}>
              <option value="metric">kg · cm</option>
              <option value="imperial">lb · ft/in</option>
            </select>
          </Row>
          <Row label={d.units === "imperial" ? "Height (ft / in)" : "Height (cm)"}>
            {d.units === "imperial" ? (
              <div className="flex gap-1">
                <input
                  value={ftDraft}
                  onChange={(e) => {
                    setFtDraft(e.target.value);
                    upd("heightCm", ftInToCm(e.target.value, inDraft));
                  }}
                  inputMode="numeric"
                  className={selectCls}
                />
                <input
                  value={inDraft}
                  onChange={(e) => {
                    setInDraft(e.target.value);
                    upd("heightCm", ftInToCm(ftDraft, e.target.value));
                  }}
                  inputMode="numeric"
                  className={selectCls}
                />
              </div>
            ) : (
              <input
                value={heightDraft}
                onChange={(e) => {
                  setHeightDraft(e.target.value);
                  const n = parseFloat(e.target.value.replace(",", "."));
                  upd("heightCm", Number.isFinite(n) ? n : null);
                }}
                inputMode="decimal"
                className={selectCls}
              />
            )}
          </Row>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Row label="Activity level">
            <select value={d.activityLevel} onChange={(e) => upd("activityLevel", e.target.value)} className={selectCls}>
              {ACTIVITY_LEVELS.map((a) => (
                <option key={a.id} value={a.id}>{a.label}</option>
              ))}
            </select>
          </Row>
          <Row label="Body fat % (optional)">
            <input value={d.bodyfatPct} onChange={(e) => upd("bodyfatPct", e.target.value)} inputMode="decimal" placeholder="—" className={selectCls} />
          </Row>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Row label="Experience">
            <select value={d.experience} onChange={(e) => upd("experience", e.target.value)} className={selectCls}>
              <option value="beginner">Beginner</option>
              <option value="intermediate">Intermediate</option>
              <option value="advanced">Advanced</option>
            </select>
          </Row>
          <Row label="Equipment">
            <select value={d.equipment} onChange={(e) => upd("equipment", e.target.value)} className={selectCls}>
              <option value="gym">Full gym</option>
              <option value="dumbbells">Dumbbells</option>
              <option value="bodyweight">Bodyweight</option>
            </select>
          </Row>
          <Row label="Days/week">
            <select value={d.daysPerWeek} onChange={(e) => upd("daysPerWeek", Number(e.target.value))} className={selectCls}>
              {[2, 3, 4, 5, 6].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </Row>
        </div>
      </div>

      <button
        onClick={save}
        disabled={busy}
        className="mt-3 w-full py-2 rounded-xl bg-slate-800 text-sm font-semibold border border-slate-700 disabled:opacity-50"
      >
        {busy ? "Saving…" : "Save profile"}
      </button>
      {msg && <div className={`text-xs mt-2 ${msg.ok ? "text-teal-400" : "text-rose-400"}`}>{msg.text}</div>}
    </Card>
  );
}
