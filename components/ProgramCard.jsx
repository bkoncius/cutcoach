"use client";

import { useState } from "react";
import { Dumbbell } from "lucide-react";
import { Card, Eyebrow } from "./ui";
import { LIBRARY, DEFAULT_PROGRAM_ID, selectProgram } from "../lib/programs";
import { saveProgram } from "../lib/db";

/* Settings sibling for the training program — own draft, own narrow writer
   (saveProgram touches only program_id + emphasis). No auto-switching ever: the
   selector's opinion renders as a hint, the user decides. */

export default function ProgramCard({ settings, onSaved }) {
  const [programId, setProgramId] = useState(settings.programId || DEFAULT_PROGRAM_ID);
  const [emphasis, setEmphasis] = useState(settings.emphasis || "balanced");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const suggested = selectProgram({ daysPerWeek: settings.daysPerWeek, equipment: settings.equipment });
  const showHint = suggested !== programId;

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const emph = emphasis === "balanced" ? null : emphasis;
      await saveProgram(programId, emph);
      onSaved?.(programId, emph);
      setMsg({ ok: true, text: "Saved — the Train tab now shows this program." });
      setTimeout(() => setMsg(null), 2500);
    } catch (e) {
      setMsg({ ok: false, text: e?.message || "Couldn't save" });
    }
    setBusy(false);
  };

  return (
    <Card>
      <div className="flex items-center gap-2">
        <Dumbbell size={14} className="text-amber-400" />
        <Eyebrow color="text-amber-400">Program</Eyebrow>
      </div>

      <div className="mt-3 space-y-2">
        {Object.entries(LIBRARY).map(([id, p]) => (
          <button
            key={id}
            onClick={() => setProgramId(id)}
            className={`w-full text-left rounded-xl border px-4 py-2.5 ${
              programId === id ? "border-amber-400 bg-slate-800" : "border-slate-700 bg-slate-900"
            }`}
          >
            <div className="text-sm font-semibold">{p.name}</div>
            <div className="text-xs text-slate-500">
              {p.daysPerWeek} days/week · {p.equipment === "gym" ? "full gym" : p.equipment}
            </div>
          </button>
        ))}
      </div>

      {showHint && (
        <div className="text-xs text-amber-400 mt-2 leading-relaxed">
          Based on your profile ({settings.daysPerWeek || "?"} days, {settings.equipment || "gym"}),{" "}
          {LIBRARY[suggested].name} may fit better — switching is your call.
        </div>
      )}

      <div className="text-xs text-slate-500 mt-3 mb-1">Emphasis</div>
      <div className="grid grid-cols-3 gap-2">
        {[
          { id: "balanced", label: "Balanced" },
          { id: "lower_glutes", label: "Lower/glutes" },
          { id: "upper", label: "Upper" },
        ].map((o) => (
          <button
            key={o.id}
            onClick={() => setEmphasis(o.id)}
            className={`rounded-xl border py-2 text-xs font-semibold ${
              emphasis === o.id ? "border-amber-400 bg-slate-800" : "border-slate-700 bg-slate-900 text-slate-300"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>

      <div className="text-xs text-slate-600 mt-2 leading-relaxed">
        Switching keeps every logged session — old workouts stay in history and the
        rotation restarts at the new program's first day.
      </div>

      <button
        onClick={save}
        disabled={busy}
        className="mt-3 w-full py-2 rounded-xl bg-slate-800 text-sm font-semibold border border-slate-700 disabled:opacity-50"
      >
        {busy ? "Saving…" : "Save program"}
      </button>
      {msg && <div className={`text-xs mt-2 ${msg.ok ? "text-teal-400" : "text-rose-400"}`}>{msg.text}</div>}
    </Card>
  );
}
