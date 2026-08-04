"use client";

import { useMemo, useState } from "react";
import { ChevronRight, ChevronLeft, Check, Dumbbell } from "lucide-react";
import { Card, Eyebrow } from "./ui";
import { ACTIVITY_LEVELS, suggestTargets, checkGoal, etaRange, ageFrom } from "../lib/calc";
import { laneText } from "../lib/lanes";
import { selectProgram, programFor } from "../lib/programs";
import {
  formatWeight, weightUnit, parseWeightInput, validWeightKg, cmToFtIn, ftInToCm,
} from "../lib/units";
import { saveOnboarding, upsertWeight } from "../lib/db";

/* The wizard between auth and the app. Runs when profiles.onboarded_at is null —
   both for brand-new accounts and for pre-migration accounts (prefilled from their
   existing row). One DB write at the very end; abandoning mid-way writes nothing. */

const PHASE_OPTIONS = [
  { id: "cut", label: "Cut", desc: "Lose fat, keep muscle" },
  { id: "maintain", label: "Maintain", desc: "Hold weight, build habits and lifts" },
  { id: "bulk", label: "Bulk", desc: "Gain lean mass, slowly" },
];

const SEX_OPTIONS = [
  { id: "male", label: "Male" },
  { id: "female", label: "Female" },
  { id: "unspecified", label: "Prefer not to say" },
];

const EXPERIENCE_OPTIONS = [
  { id: "beginner", label: "Beginner", desc: "< 1 year of consistent lifting" },
  { id: "intermediate", label: "Intermediate", desc: "1–3 years" },
  { id: "advanced", label: "Advanced", desc: "3+ years" },
];

const EQUIPMENT_OPTIONS = [
  { id: "gym", label: "Full gym", desc: "Barbells, machines, the works" },
  { id: "dumbbells", label: "Dumbbells", desc: "Home setup with adjustable DBs" },
  { id: "bodyweight", label: "Bodyweight", desc: "No equipment" },
];

function Field({ label, children }) {
  return (
    <div>
      <div className="text-xs text-slate-500 mb-1">{label}</div>
      {children}
    </div>
  );
}

const inputCls =
  "w-full bg-slate-800 rounded-xl px-4 py-3 font-mono outline-none border border-slate-700 focus:border-amber-400";

function OptionGrid({ options, value, onChange, cols = 1 }) {
  return (
    <div className={`grid gap-2 ${cols === 2 ? "grid-cols-2" : "grid-cols-1"}`}>
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          className={`text-left rounded-xl border px-4 py-3 ${
            value === o.id
              ? "border-amber-400 bg-slate-800"
              : "border-slate-700 bg-slate-900 text-slate-300"
          }`}
        >
          <div className="text-sm font-semibold">{o.label}</div>
          {o.desc && <div className="text-xs text-slate-500 mt-0.5">{o.desc}</div>}
        </button>
      ))}
    </div>
  );
}

export default function Onboarding({ settings, onComplete }) {
  const s0 = settings || {};
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // Draft state, prefilled from the existing row when one predates the wizard.
  const [displayName, setDisplayName] = useState(s0.displayName || "");
  const [sex, setSex] = useState(s0.sex || null);
  const [birthdate, setBirthdate] = useState(s0.birthdate || "");
  const [units, setUnits] = useState(s0.units || "metric");
  const [heightCm, setHeightCm] = useState(s0.heightCm || null);
  const [heightDraft, setHeightDraft] = useState(
    s0.heightCm ? String(Math.round(s0.heightCm)) : ""
  );
  const [ftDraft, setFtDraft] = useState(s0.heightCm ? String(cmToFtIn(s0.heightCm).ft) : "");
  const [inDraft, setInDraft] = useState(s0.heightCm ? String(cmToFtIn(s0.heightCm).inch) : "");

  const [weightDraft, setWeightDraft] = useState(
    s0.startWeight != null ? formatWeight(s0.startWeight, s0.units || "metric") : ""
  );
  const [bodyfatDraft, setBodyfatDraft] = useState(s0.bodyfatPct != null ? String(s0.bodyfatPct) : "");

  const [phase, setPhase] = useState(s0.phase || "cut");
  const [goalDraft, setGoalDraft] = useState(
    s0.targetWeight != null ? formatWeight(s0.targetWeight, s0.units || "metric") : ""
  );

  const [activityLevel, setActivityLevel] = useState(s0.activityLevel || null);
  const [experience, setExperience] = useState(s0.experience || null);
  const [equipment, setEquipment] = useState(s0.equipment || null);
  const [daysPerWeek, setDaysPerWeek] = useState(s0.daysPerWeek || 4);
  const [emphasis, setEmphasis] = useState(s0.emphasis || "balanced");

  const weightKg = parseWeightInput(weightDraft, units);
  const goalKg = phase === "maintain" ? weightKg : parseWeightInput(goalDraft, units);
  const bodyfatPct = bodyfatDraft.trim() === "" ? null : parseFloat(bodyfatDraft.replace(",", "."));

  const age = ageFrom(birthdate);
  const profileDraft = { sex, birthdate, heightCm, activityLevel, bodyfatPct };

  const goalCheck =
    phase === "maintain" ? { ok: true } : checkGoal({ phase, currentKg: weightKg, goalKg, heightCm });
  const eta = weightKg && goalKg ? etaRange(phase, weightKg, goalKg, profileDraft) : null;

  const plan = useMemo(
    () => (weightKg && sex && birthdate && heightCm && activityLevel ? suggestTargets(profileDraft, weightKg, phase) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sex, birthdate, heightCm, activityLevel, bodyfatPct, weightKg, phase]
  );

  const syncHeight = (v) => {
    setHeightDraft(v);
    const n = parseFloat(v.replace(",", "."));
    setHeightCm(Number.isFinite(n) && n >= 100 && n <= 250 ? n : null);
  };
  const syncFtIn = (ft, inch) => {
    setFtDraft(ft);
    setInDraft(inch);
    const cm = ftInToCm(ft, inch);
    setHeightCm(cm >= 100 && cm <= 250 ? cm : null);
  };

  const stepValid = [
    // 0 — who you are
    !!sex && !!birthdate && age != null && age >= 13 && age <= 100 && !!heightCm,
    // 1 — where you are now
    validWeightKg(weightKg) && (bodyfatPct == null || (bodyfatPct > 3 && bodyfatPct < 75)),
    // 2 — the goal
    goalCheck.ok,
    // 3 — lifestyle
    !!activityLevel && !!experience && !!equipment && daysPerWeek >= 2 && daysPerWeek <= 6,
    // 4 — the plan
    !!plan,
  ][step];

  const finish = async () => {
    setBusy(true);
    setErr("");
    try {
      const payload = {
        displayName: displayName.trim() || null,
        sex,
        birthdate,
        heightCm,
        activityLevel,
        experience,
        equipment,
        daysPerWeek,
        units,
        bodyfatPct,
        programId: selectProgram({ daysPerWeek, equipment }),
        emphasis: emphasis === "balanced" ? null : emphasis,
        phase,
        kcalTarget: plan.kcalTarget,
        proteinTarget: plan.proteinTarget,
        startWeight: Math.round(weightKg * 10) / 10,
        targetWeight: Math.round(goalKg * 10) / 10,
        timezone: (() => {
          try {
            return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
          } catch {
            return null;
          }
        })(),
        prevKcal: s0.kcalTarget ?? null,
        prevProtein: s0.proteinTarget ?? null,
        context: { tdeeFormula: plan.tdee, bmr: plan.bmr, weightKg, source: "wizard" },
      };
      await saveOnboarding(payload);
      // Seed the trend series so day one shows a real data point, not an empty chart.
      const today = new Date();
      const tk = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      await upsertWeight(tk, Math.round(weightKg * 10) / 10).catch(() => {});
      onComplete(payload, tk);
    } catch (e) {
      setErr(e?.message || "Couldn't save — try again.");
      setBusy(false);
    }
  };

  const steps = [
    /* ---------- 0: you ---------- */
    <div key="you" className="space-y-4">
      <Field label="What should the coach call you?">
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="First name" className={inputCls} />
      </Field>
      <Field label="Units">
        <div className="grid grid-cols-2 gap-2">
          {[
            { id: "metric", label: "kg · cm" },
            { id: "imperial", label: "lb · ft/in" },
          ].map((o) => (
            <button
              key={o.id}
              onClick={() => setUnits(o.id)}
              className={`rounded-xl border px-4 py-3 text-sm font-semibold ${
                units === o.id ? "border-amber-400 bg-slate-800" : "border-slate-700 bg-slate-900 text-slate-300"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      </Field>
      <Field label="Sex — used only for calorie and rate math (Mifflin-St Jeor)">
        <OptionGrid options={SEX_OPTIONS} value={sex} onChange={setSex} />
      </Field>
      <Field label="Birthdate">
        <input type="date" value={birthdate} onChange={(e) => setBirthdate(e.target.value)} className={inputCls} />
        {birthdate && age != null && age < 13 && (
          <div className="text-xs text-rose-400 mt-1">CutCoach isn't for under-13s.</div>
        )}
      </Field>
      <Field label="Height">
        {units === "metric" ? (
          <div className="flex items-center gap-2">
            <input value={heightDraft} onChange={(e) => syncHeight(e.target.value)} inputMode="decimal" placeholder="182" className={inputCls} />
            <span className="text-sm text-slate-500">cm</span>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <input value={ftDraft} onChange={(e) => syncFtIn(e.target.value, inDraft)} inputMode="numeric" placeholder="6" className={inputCls} />
            <span className="text-sm text-slate-500">ft</span>
            <input value={inDraft} onChange={(e) => syncFtIn(ftDraft, e.target.value)} inputMode="numeric" placeholder="0" className={inputCls} />
            <span className="text-sm text-slate-500">in</span>
          </div>
        )}
      </Field>
    </div>,

    /* ---------- 1: now ---------- */
    <div key="now" className="space-y-4">
      <Field label={`Current weight (${weightUnit(units)})`}>
        <input value={weightDraft} onChange={(e) => setWeightDraft(e.target.value)} inputMode="decimal" placeholder={units === "imperial" ? "190" : "87.0"} className={inputCls} />
      </Field>
      <Field label="Body fat % — optional, skip if unsure">
        <input value={bodyfatDraft} onChange={(e) => setBodyfatDraft(e.target.value)} inputMode="decimal" placeholder="—" className={inputCls} />
        <div className="text-xs text-slate-600 mt-1 leading-relaxed">
          A rough estimate is fine. It refines the protein target and the healthy rate lane; leaving it blank uses safe defaults.
        </div>
      </Field>
    </div>,

    /* ---------- 2: goal ---------- */
    <div key="goal" className="space-y-4">
      <Field label="Phase">
        <OptionGrid options={PHASE_OPTIONS} value={phase} onChange={setPhase} />
      </Field>
      {phase !== "maintain" && (
        <Field label={`Goal weight (${weightUnit(units)})`}>
          <input value={goalDraft} onChange={(e) => setGoalDraft(e.target.value)} inputMode="decimal" placeholder={units === "imperial" ? "165" : "75.0"} className={inputCls} />
        </Field>
      )}
      {!goalCheck.ok && goalCheck.error && <div className="text-xs text-rose-400">{goalCheck.error}</div>}
      {goalCheck.ok && goalCheck.warning && <div className="text-xs text-amber-400">{goalCheck.warning}</div>}
      {goalCheck.ok && eta && (
        <div className="text-xs text-slate-500 leading-relaxed">
          At a healthy rate that's roughly <span className="text-slate-300 font-semibold">{eta.minWeeks}–{eta.maxWeeks} weeks</span>. {laneText(phase, weightKg, profileDraft, units)}
        </div>
      )}
    </div>,

    /* ---------- 3: life ---------- */
    <div key="life" className="space-y-4">
      <Field label="Day-to-day activity (outside the gym)">
        <OptionGrid options={ACTIVITY_LEVELS.map((a) => ({ id: a.id, label: a.label, desc: a.desc }))} value={activityLevel} onChange={setActivityLevel} />
      </Field>
      <Field label="Lifting experience">
        <OptionGrid options={EXPERIENCE_OPTIONS} value={experience} onChange={setExperience} cols={1} />
      </Field>
      <Field label="Equipment">
        <OptionGrid options={EQUIPMENT_OPTIONS} value={equipment} onChange={setEquipment} />
      </Field>
      <Field label={`Training days per week: ${daysPerWeek}`}>
        <div className="grid grid-cols-5 gap-2">
          {[2, 3, 4, 5, 6].map((n) => (
            <button
              key={n}
              onClick={() => setDaysPerWeek(n)}
              className={`rounded-xl border py-2 text-sm font-semibold ${
                daysPerWeek === n ? "border-amber-400 bg-slate-800" : "border-slate-700 bg-slate-900 text-slate-300"
              }`}
            >
              {n}
            </button>
          ))}
        </div>
      </Field>
      <Field label="Training emphasis — your call, adjustable any time">
        <OptionGrid
          options={[
            { id: "balanced", label: "Balanced", desc: "Even push/pull/legs development" },
            { id: "lower_glutes", label: "Lower & glutes", desc: "Extra hip-thrust and glute volume" },
            { id: "upper", label: "Upper body", desc: "Extra back and shoulder volume" },
          ]}
          value={emphasis}
          onChange={setEmphasis}
        />
      </Field>
    </div>,

    /* ---------- 4: the plan ---------- */
    <div key="plan" className="space-y-3">
      {plan ? (
        <>
          <PlanRow label="Basal metabolism" value={`${plan.bmr} kcal`} note="Mifflin-St Jeor from your sex, age, height and weight" />
          <PlanRow label="Est. daily burn" value={`${plan.tdee} kcal`} note="scaled by your activity level — refined weekly from your real data" />
          <PlanRow
            label="Calorie target"
            value={`${plan.kcalTarget} kcal`}
            note={
              plan.floorApplied
                ? "clamped to the safe minimum — the deficit lever is small at this size"
                : phase === "cut"
                ? "a mid-lane deficit; adjusts as your trend responds"
                : phase === "bulk"
                ? "a small surplus; adjusts as your trend responds"
                : "estimated maintenance; adjusts as your trend responds"
            }
            highlight
          />
          <PlanRow label="Protein target" value={`${plan.proteinTarget} g`} note="the non-negotiable; everything else flexes" highlight />
          {s0.kcalTarget != null && s0.kcalTarget !== plan.kcalTarget && (
            <div className="text-xs text-slate-500 leading-relaxed">
              You currently run {s0.kcalTarget} kcal / {s0.proteinTarget} g. Finishing switches you to the computed plan; you can adjust either number in settings afterwards.
            </div>
          )}
          <Card className="flex items-center gap-3">
            <Dumbbell size={18} className="text-teal-400" />
            <div className="text-sm">
              <div className="font-semibold">{programFor(selectProgram({ daysPerWeek, equipment })).name}</div>
              <div className="text-xs text-slate-500">
                Picked for {daysPerWeek} days/week with {equipment === "gym" ? "a full gym" : equipment === "dumbbells" ? "dumbbells" : "no equipment"}
                {emphasis !== "balanced" ? `, ${emphasis === "lower_glutes" ? "lower/glute" : "upper-body"} emphasis` : ""}. Change it any time in settings.
              </div>
            </div>
          </Card>
        </>
      ) : (
        <div className="text-sm text-slate-500">Fill in the earlier steps to see your plan.</div>
      )}
      {err && <div className="text-xs text-rose-400">{err}</div>}
    </div>,
  ];

  const titles = ["Who are you?", "Where are you now?", "The goal", "Your week", "Your plan"];

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100" style={{ fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
      <div
        className="max-w-md mx-auto px-4"
        style={{
          paddingTop: "calc(1.5rem + env(safe-area-inset-top))",
          paddingBottom: "calc(2rem + env(safe-area-inset-bottom))",
        }}
      >
        <Eyebrow color="text-amber-400">CutCoach · setup {step + 1}/5</Eyebrow>
        <h1 className="text-xl font-bold tracking-tight mt-1 mb-4">{titles[step]}</h1>

        {/* progress dots */}
        <div className="flex gap-1.5 mb-5">
          {titles.map((_, i) => (
            <div key={i} className={`h-1 flex-1 rounded-full ${i <= step ? "bg-amber-400" : "bg-slate-800"}`} />
          ))}
        </div>

        {steps[step]}

        <div className="flex gap-2 mt-6">
          {step > 0 && (
            <button
              onClick={() => setStep(step - 1)}
              className="px-4 py-3 rounded-xl border border-slate-700 text-slate-300"
              aria-label="Back"
            >
              <ChevronLeft size={18} />
            </button>
          )}
          {step < steps.length - 1 ? (
            <button
              onClick={() => setStep(step + 1)}
              disabled={!stepValid}
              className="flex-1 py-3 rounded-xl bg-amber-400 text-slate-950 font-bold disabled:opacity-40 flex items-center justify-center gap-1"
            >
              Continue <ChevronRight size={16} />
            </button>
          ) : (
            <button
              onClick={finish}
              disabled={!stepValid || busy}
              className="flex-1 py-3 rounded-xl bg-amber-400 text-slate-950 font-bold disabled:opacity-40 flex items-center justify-center gap-2"
            >
              {busy ? "Saving…" : (<><Check size={16} /> Start coaching</>)}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function PlanRow({ label, value, note, highlight }) {
  return (
    <Card className={highlight ? "border-amber-400 border-opacity-30" : ""}>
      <div className="flex items-baseline justify-between">
        <div className="text-sm text-slate-300">{label}</div>
        <div className="font-mono text-lg font-bold">{value}</div>
      </div>
      {note && <div className="text-xs text-slate-500 mt-1 leading-relaxed">{note}</div>}
    </Card>
  );
}
