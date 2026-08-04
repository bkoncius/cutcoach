// Builds the coach's system prompt from live data. Pure and isomorphic.
//
// Everything the model needs — identity, lanes, engine state, the data block — goes
// into the SYSTEM prompt, sent fresh on every call. Chat history stays clean
// user/assistant text, which fixes the old defect where context was prepended to the
// newest user turn only and history replay silently lost it.
//
// The ENGINE block is the deterministic-engine contract: the model narrates those
// numbers and is explicitly forbidden from inventing its own.

import { ageFrom } from "./calc.js";
import { laneRules } from "./lanes.js";
import { programFor, getTemplate } from "./programs.js";

const fmt1 = (n) => (Math.round(n * 10) / 10).toFixed(1);
const shortDate = (k) => k.slice(5).replace("-", ".");

export function buildCoachContext({ settings, days, workouts, trendState, proposalRow, todayKey }) {
  const program = programFor(settings.programId);
  const laneProfile = { sex: settings.sex, bodyfatPct: settings.bodyfatPct, experience: settings.experience };
  const trendWeight = trendState?.trendWeight ?? null;
  const rate = trendState?.rate ?? null;

  /* ---------- identity ---------- */
  const name = settings.displayName || "the client";
  const sexWord = settings.sex === "male" ? "male" : settings.sex === "female" ? "female" : "unspecified sex";
  const age = settings.birthdate ? ageFrom(settings.birthdate) : null;
  const equipmentWord =
    settings.equipment === "dumbbells" ? "dumbbells only" : settings.equipment === "bodyweight" ? "no equipment" : "full gym";
  const identity =
    `You are the built-in AI coach in CutCoach, a personal training & nutrition app. ` +
    `Client: ${name}, ${sexWord}${age ? `, ${age}` : ""}` +
    `${settings.heightCm ? `, ${Math.round(settings.heightCm)} cm` : ""}` +
    `${settings.bodyfatPct ? `, ~${settings.bodyfatPct}% body fat` : ""}. ` +
    `${settings.experience || "intermediate"} lifter, ${equipmentWord}, ${settings.daysPerWeek || 4} training days/week. ` +
    `Program: ${program.name} with cardio finishers.`;

  /* ---------- state + rules ---------- */
  const trendLine =
    trendWeight != null
      ? `Current trend weight ${fmt1(trendWeight)} kg${rate != null ? `, moving ${rate > 0 ? "+" : ""}${rate.toFixed(2)} kg/week` : " (not enough weigh-ins yet for a rate)"}.`
      : "No weigh-ins yet.";
  const rules = laneRules(settings.phase, trendWeight, laneProfile);

  const femaleNote =
    settings.sex === "female"
      ? "\nFemale-specific: expect intra-month water-weight fluctuations of 1-2 kg on a roughly monthly rhythm; judge progress across 2-4 week trend windows and never recommend calorie cuts in response to a single-week stall that may coincide with cyclical retention."
      : "";
  const unitsNote =
    settings.units === "imperial"
      ? "\nThe client thinks in pounds — communicate weights in lb (data below is in kg; convert when you mention numbers)."
      : "";

  /* ---------- the engine block ---------- */
  const engineBlock = buildEngineBlock(proposalRow);

  /* ---------- data ---------- */
  const workoutByDate = {};
  (workouts || []).forEach((w) => {
    workoutByDate[w.date] = getTemplate(settings.programId, w.template).name;
  });

  const lines = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const v = days[k];
    const parts = [];
    if (v && v.weight != null) parts.push(`${fmt1(v.weight)}kg`);
    if (v && (v.meals || []).length) {
      const ms = v.meals;
      const kc = ms.reduce((s, m) => s + (Number(m.kcal) || 0), 0);
      const pr = ms.reduce((s, m) => s + (Number(m.protein) || 0), 0);
      const cb = ms.reduce((s, m) => s + (Number(m.carbs) || 0), 0);
      const ft = ms.reduce((s, m) => s + (Number(m.fat) || 0), 0);
      parts.push(`${kc}kcal (${pr}P/${cb}C/${ft}F)${v.intakeComplete ? "" : " [incomplete log]"}`);
    }
    if (workoutByDate[k]) parts.push(`trained ${workoutByDate[k]}`);
    if (parts.length) lines.push(`${shortDate(k)}: ${parts.join(", ")}`);
  }

  const todayMeals = (((days[todayKey] || {}).meals) || [])
    .map((m) => `${m.name} (${m.kcal}kcal ${m.protein}P/${m.carbs || 0}C/${m.fat || 0}F)`)
    .join("; ");

  const recentW = [...(workouts || [])]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 6)
    .map((w) => {
      const ex = w.exercises
        .map((e) => {
          const sets = (e.sets || []).filter((s) => s.w && s.r);
          return sets.length ? `${e.name} ${sets.map((s) => `${s.w}×${s.r}`).join(",")}` : null;
        })
        .filter(Boolean)
        .join("; ");
      return `${shortDate(w.date)} ${getTemplate(settings.programId, w.template).name}${w.finisher ? " +cardio" : ""} — ${ex || "logged"}`;
    });

  return `${identity}
Phase start weight ${settings.startWeight} kg, phase goal ${settings.targetWeight} kg.
Daily targets: ${settings.kcalTarget} kcal, ${settings.proteinTarget} g protein.
${trendLine}
${rules}${femaleNote}${unitsNote}
${engineBlock}
Universal rules: judge weight by the trend weight only, never single days. Flag 2+ missing logging days honestly. Suggest a deload every 5–6 weeks of hard training.
Style: thorough and specific — reference actual numbers from the data. For check-ins cover: weight trajectory vs the phase lane; calorie and protein adherence; macro balance, including carb placement on training vs rest days and fat consistency; lift-by-lift progression; then one concrete priority for today. 250–400 words for check-ins, shorter for quick questions. Plain text only — no markdown, no asterisks, no headers, no bullet symbols. Short paragraphs.

DATA — last 14 days (weight, intake, training):
${lines.length ? lines.join("\n") : "No daily logs yet."}

TODAY'S MEALS SO FAR:
${todayMeals || "None yet."}

RECENT WORKOUTS (all logged sets):
${recentW.length ? recentW.join("\n") : "None logged yet."}`;
}

// The deterministic-engine contract. AUTHORITATIVE — the model must reference these
// numbers and never propose different ones.
function buildEngineBlock(row) {
  if (!row || !row.proposal) {
    return "ENGINE (authoritative — never propose different numbers): no weekly review has run yet. If asked about changing calories, explain that the weekly review sizes any change from measured data, and adjustments before that are manual.";
  }
  const p = row.proposal;
  const b = p.basis || {};
  const basisLine =
    b.tdeeBlended != null
      ? ` Measured burn est. ${b.tdeeBlended} kcal/day (${Math.round((b.blendWeight || 0) * 100)}% from logged data, ${b.completeDays ?? 0} complete days, confidence ${b.confidence || "?"}).`
      : "";

  if (row.status === "pending") {
    return (
      `ENGINE (authoritative — never propose different numbers): this week's review is PENDING the client's decision.` +
      basisLine +
      ` Proposal: ${p.newKcal} kcal/day (${p.step > 0 ? "+" : ""}${p.step})${p.newProtein ? `, protein ${p.newProtein} g` : ""}. Reason: ${p.reason} ` +
      `If asked about calorie changes, explain THIS proposal and its reasoning; the client applies it from the card on the Today tab — you cannot apply it, and you must not suggest different numbers.`
    );
  }
  if (row.status === "applied") {
    return `ENGINE (authoritative): this week's review was applied — targets are current.${basisLine} Do not propose further target changes; the next review is Monday.`;
  }
  if (row.status === "dismissed") {
    return `ENGINE (authoritative): the client saw this week's proposal and chose not to apply it.${basisLine} Respect that choice; do not re-litigate unless asked. The next review is Monday.`;
  }
  // status 'none'
  return `ENGINE (authoritative — never propose different numbers): this week's review ran with no change.${basisLine} Verdict: ${p.verdict || "n/a"}${p.holdReason ? ` — ${p.holdReason}` : ""}. If asked about changing calories, explain this verdict; the next review is Monday.`;
}
