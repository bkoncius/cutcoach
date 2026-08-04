"use client";

import { useState } from "react";
import { Gauge, Check, X } from "lucide-react";
import { Card, Eyebrow } from "./ui";
import { applyProposal, dismissProposal } from "../lib/db";

/* The weekly review card — renders on Today while the engine's proposal for the
   current week is pending. The numbers were computed server-side by the deterministic
   engine; this card only applies or dismisses them. The AI coach narrates the same
   row; it never gets to change the numbers. */

export default function ProposalCard({ row, settings, onApplied, onDismissed }) {
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const p = row?.proposal;
  if (!row || row.status !== "pending" || !p) return null;

  const kcalDelta = p.step || 0;
  const proteinChanges = p.newProtein != null && p.newProtein !== settings.proteinTarget;

  const onApply = async () => {
    setBusy("apply");
    setErr("");
    try {
      const res = await applyProposal(row, settings);
      onApplied(res, p);
    } catch (e) {
      setErr(e?.message || "Couldn't apply — try again.");
      setBusy("");
    }
  };

  const onNotNow = async () => {
    setBusy("dismiss");
    setErr("");
    try {
      await dismissProposal(row.id);
      onDismissed();
    } catch (e) {
      setErr(e?.message || "Couldn't dismiss — try again.");
      setBusy("");
    }
  };

  return (
    <Card className="border-teal-400 border-opacity-40">
      <div className="flex items-center gap-2">
        <Gauge size={14} className="text-teal-400" />
        <Eyebrow color="text-teal-400">Weekly review</Eyebrow>
      </div>

      <div className="flex items-end gap-3 mt-2">
        <div className="font-mono text-3xl font-bold tracking-tight">{p.newKcal}</div>
        <div className="pb-0.5 text-slate-400 text-sm">kcal/day</div>
        {kcalDelta !== 0 && (
          <div className={`ml-auto mb-0.5 font-mono text-sm px-2 py-1 rounded-lg bg-slate-800 ${kcalDelta < 0 ? "text-amber-300" : "text-teal-300"}`}>
            {kcalDelta > 0 ? "+" : ""}{kcalDelta}
          </div>
        )}
      </div>
      {proteinChanges && (
        <div className="text-sm text-slate-300 mt-1">
          Protein → <span className="font-mono font-bold">{p.newProtein} g</span>
        </div>
      )}

      <div className="text-xs text-slate-400 mt-2 leading-relaxed">{p.reason}</div>

      <div className="flex gap-2 mt-3">
        <button
          onClick={onApply}
          disabled={!!busy}
          className="flex-1 py-2 rounded-xl bg-teal-400 text-slate-950 text-sm font-bold disabled:opacity-50 flex items-center justify-center gap-1"
        >
          <Check size={14} /> {busy === "apply" ? "Applying…" : "Apply"}
        </button>
        <button
          onClick={onNotNow}
          disabled={!!busy}
          className="px-4 py-2 rounded-xl border border-slate-700 text-slate-400 text-sm disabled:opacity-50 flex items-center justify-center gap-1"
        >
          <X size={14} /> Not now
        </button>
      </div>
      {err && <div className="text-xs text-rose-400 mt-2">{err}</div>}
    </Card>
  );
}
