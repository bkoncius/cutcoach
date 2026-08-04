// Energy and target calculations. Pure and isomorphic.
//
// These formulas are the COLD-START PRIOR, not the truth: the adaptive engine
// (lib/engine.js) overrides them with measured energy balance within a few weeks of
// real logging. Precision here matters less than being sex-aware and safe-floored —
// the old app gave literally everyone 2200 kcal / 175 g protein.

import { laneFor } from "./lanes.js";

export const ACTIVITY_LEVELS = [
  { id: "sedentary", label: "Sedentary", desc: "Desk job, little walking, no regular exercise", mult: 1.2 },
  { id: "light", label: "Lightly active", desc: "On your feet some of the day, or 1–2 workouts a week", mult: 1.375 },
  { id: "moderate", label: "Moderately active", desc: "Regular training 3–5 days a week, otherwise deskbound", mult: 1.55 },
  { id: "active", label: "Active", desc: "Physical job or training most days", mult: 1.725 },
  { id: "very_active", label: "Very active", desc: "Hard physical work plus regular training", mult: 1.9 },
];

const MULT = Object.fromEntries(ACTIVITY_LEVELS.map((a) => [a.id, a.mult]));

// Net intake floors. Sex-specific because minimum safe intake tracks lean mass and
// essential fat; 'unspecified' takes the midpoint rather than either extreme.
export const KCAL_FLOOR = { male: 1500, female: 1200, unspecified: 1350 };

export function ageFrom(birthdate, asOf = new Date()) {
  if (!birthdate) return null;
  const b = new Date(`${birthdate}T00:00:00Z`);
  if (Number.isNaN(b.getTime())) return null;
  const now = asOf instanceof Date ? asOf : new Date(asOf);
  let age = now.getUTCFullYear() - b.getUTCFullYear();
  const beforeBirthday =
    now.getUTCMonth() < b.getUTCMonth() ||
    (now.getUTCMonth() === b.getUTCMonth() && now.getUTCDate() < b.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

// Mifflin-St Jeor. The sex constant: +5 male, −161 female. For 'prefer not to say'
// we take the midpoint (−78) — documented, deliberate, and only ~80 kcal from either
// pole, which the adaptive engine erases anyway.
export function bmr({ sex, weightKg, heightCm, age }) {
  const w = Number(weightKg);
  const h = Number(heightCm);
  const a = Number(age);
  if (![w, h, a].every(Number.isFinite) || w <= 0 || h <= 0 || a <= 0) return null;
  const sexTerm = sex === "male" ? 5 : sex === "female" ? -161 : -78;
  return Math.round(10 * w + 6.25 * h - 5 * a + sexTerm);
}

export function formulaTdee(profile, weightKg) {
  const b = bmr({
    sex: profile?.sex,
    weightKg,
    heightCm: profile?.heightCm,
    age: ageFrom(profile?.birthdate),
  });
  if (b == null) return null;
  const mult = MULT[profile?.activityLevel] || MULT.moderate;
  return Math.round(b * mult);
}

const round50 = (n) => Math.round(n / 50) * 50;
const round5 = (n) => Math.round(n / 5) * 5;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// Daily deficit/surplus that lands mid-lane for this bodyweight.
// cut: mid-lane is ~0.75% BW/wk → kcal/day = 0.0075 × kg × 7700 / 7 ≈ 8.25 × kg
// bulk: ~0.23% BW/wk → ≈ 2.5 × kg
function phaseDelta(phase, weightKg) {
  if (phase === "cut") return -clamp(8.25 * weightKg, 300, 750);
  if (phase === "bulk") return clamp(2.5 * weightKg, 150, 350);
  return 0;
}

export function proteinTarget(phase, weightKg, bodyfatPct) {
  const w = Number(weightKg);
  if (!Number.isFinite(w) || w <= 0) return null;
  const bf = Number(bodyfatPct);
  let grams;
  if (phase === "cut") {
    // g/kg-total overshoots badly at high body fat — switch to lean-mass basis there.
    grams = Number.isFinite(bf) && bf >= 30 ? 2.2 * (w * (1 - bf / 100)) : 2.0 * w;
  } else {
    grams = 1.8 * w;
  }
  return Math.max(100, round5(grams));
}

/**
 * The cold-start plan. Replaces the PHASES[p].suggest presets (absolute numbers for
 * one specific 85 kg man) with numbers derived from the actual person.
 * -> { bmr, tdee, kcalTarget, proteinTarget, floorApplied } | null when un-computable
 */
export function suggestTargets(profile, weightKg, phase) {
  const w = Number(weightKg);
  if (!Number.isFinite(w) || w <= 0) return null;
  const tdee = formulaTdee(profile, w);
  if (tdee == null) return null;

  let kcal = tdee + phaseDelta(phase, w);
  // The deficit may not exceed 25% of TDEE even before the absolute floor.
  if (phase === "cut") kcal = Math.max(kcal, Math.round(tdee * 0.75));
  const floor = KCAL_FLOOR[profile?.sex] ?? KCAL_FLOOR.unspecified;
  const floorApplied = kcal < floor;
  kcal = round50(Math.max(kcal, floor));

  return {
    bmr: bmr({ sex: profile?.sex, weightKg: w, heightCm: profile?.heightCm, age: ageFrom(profile?.birthdate) }),
    tdee,
    kcalTarget: kcal,
    proteinTarget: proteinTarget(phase, w, profile?.bodyfatPct),
    floorApplied,
  };
}

/* ---------------- goal sanity (onboarding) ---------------- */

export function bmiFor(weightKg, heightCm) {
  const w = Number(weightKg);
  const h = Number(heightCm) / 100;
  if (!Number.isFinite(w) || !Number.isFinite(h) || h <= 0) return null;
  return w / (h * h);
}

/**
 * Bounds-check a goal weight against the phase direction and basic health limits.
 * -> { ok, error?, warning? }  error blocks, warning shows but allows.
 */
export function checkGoal({ phase, currentKg, goalKg, heightCm }) {
  const cur = Number(currentKg);
  const goal = Number(goalKg);
  if (!Number.isFinite(cur) || !Number.isFinite(goal)) return { ok: false, error: "Enter a goal weight." };

  if (phase === "maintain") return { ok: true };
  if (phase === "cut" && goal >= cur) return { ok: false, error: "A cut goal has to be below your current weight." };
  if (phase === "bulk" && goal <= cur) return { ok: false, error: "A bulk goal has to be above your current weight." };

  const goalBmi = bmiFor(goal, heightCm);
  if (phase === "cut") {
    if (goalBmi != null && goalBmi < 17.5) return { ok: false, error: "That goal is under BMI 17.5 — not something this app will coach toward." };
    if (goalBmi != null && goalBmi < 18.5) return { ok: true, warning: "That goal is under BMI 18.5 — consider a higher target." };
    if ((cur - goal) / cur > 0.25) return { ok: true, warning: "That's more than 25% of your bodyweight — plan on phase breaks along the way." };
  }
  if (phase === "bulk" && (goal - cur) / cur > 0.15) {
    return { ok: true, warning: "More than 15% up is a long bulk — most people do it in stages." };
  }
  return { ok: true };
}

// "at −0.44 to −0.87 kg/wk you'd arrive in 14–28 weeks"
export function etaRange(phase, currentKg, goalKg, profile = {}) {
  const lane = laneFor(phase, currentKg, profile);
  if (!lane || phase === "maintain") return null;
  const dist = Math.abs(Number(goalKg) - Number(currentKg));
  if (!Number.isFinite(dist) || dist <= 0) return null;
  const fast = Math.max(Math.abs(lane.minKg), Math.abs(lane.maxKg));
  const slow = Math.min(Math.abs(lane.minKg), Math.abs(lane.maxKg));
  if (slow === 0) return null;
  return { minWeeks: Math.ceil(dist / fast), maxWeeks: Math.ceil(dist / slow) };
}
