// Phase lanes as data — the single source of truth for "what rate of change is this
// phase aiming for". Bands are % of bodyweight per week, resolved to kg for the
// person, so a 60 kg and a 100 kg client get proportionally sensible targets.
//
// Before this module the lanes lived as English prose in the coach prompt while the
// only code check (onTrack) contradicted them — cut accepted ANY negative rate. Every
// consumer (Today badge, Trend tab, reminder copy, coach prompt, engine) now reads or
// generates from here, so UI, notifications, and AI can no longer disagree.
//
// Pure and isomorphic. Imports trend.js only (same constraints).

import { computeTrend } from "./trend.js";
import { kgToLb } from "./units.js";

export const LANES = {
  cut: {
    pct: [-1.0, -0.5], // % BW/week
    leanPct: [-0.75, -0.35], // already lean → slower to protect muscle
    absCapKg: -1.0, // never target faster than 1 kg/wk regardless of size
  },
  maintain: { pct: [-0.25, 0.25] },
  bulk: {
    // Gain capacity tracks training age, not size.
    beginner: [0.25, 0.5],
    intermediate: [0.15, 0.35],
    advanced: [0.1, 0.25],
  },
};

// "Lean" thresholds for the gentler cut band. Sex-specific because essential body
// fat differs; unspecified uses the midpoint.
const LEAN_BF = { male: 15, female: 23, unspecified: 19 };

// Half-away-from-zero so cut and bulk bands mirror: −0.435 → −0.44 like +0.435 → +0.44.
// Math.round alone rounds negative halves toward zero and skews the cut band by 0.01.
const round2 = (n) => (Math.sign(n) * Math.round(Math.abs(n) * 100)) / 100;
const fmt2 = (n) => {
  const s = round2(n);
  return `${s > 0 ? "+" : s < 0 ? "−" : ""}${Math.abs(s).toFixed(2).replace(/0$/, "")}`;
};

function pctBand(phase, profile) {
  if (phase === "bulk") {
    const exp = profile?.experience || "intermediate";
    return LANES.bulk[exp] || LANES.bulk.intermediate;
  }
  if (phase === "cut") {
    const bf = profile?.bodyfatPct;
    const sex = profile?.sex || "unspecified";
    const lean = bf != null && Number(bf) > 0 && Number(bf) < (LEAN_BF[sex] ?? LEAN_BF.unspecified);
    return lean ? LANES.cut.leanPct : LANES.cut.pct;
  }
  return LANES.maintain.pct;
}

/**
 * Resolve the lane to kg/week for a given bodyweight.
 * -> { minKg, maxKg, midKg } with minKg <= maxKg numerically, or null without a weight.
 */
export function laneFor(phase, weightKg, profile = {}) {
  const w = Number(weightKg);
  if (!Number.isFinite(w) || w <= 0) return null;
  const [a, b] = pctBand(phase || "cut", profile);
  let minKg = round2((Math.min(a, b) * w) / 100);
  let maxKg = round2((Math.max(a, b) * w) / 100);
  if ((phase || "cut") === "cut") {
    minKg = Math.max(minKg, LANES.cut.absCapKg); // cap the fast edge at −1.0 kg/wk
  }
  return { minKg, maxKg, midKg: round2((minKg + maxKg) / 2) };
}

/**
 * Where is this rate relative to the lane?
 * -> "in_lane" | "slow" | "fast" | "unknown"
 *
 * "slow"/"fast" mean progress speed toward the phase's goal:
 *   cut  — slow = not losing enough, fast = losing too fast
 *   bulk — slow = not gaining,      fast = gaining too fast
 *   maintain has no goal direction: fast = drifting up, slow = drifting down.
 */
export function laneVerdict(phase, rate, weightKg, profile = {}) {
  if (rate == null) return "unknown";
  const lane = laneFor(phase, weightKg, profile);
  if (!lane) return "unknown";
  const p = phase || "cut";
  if (p === "cut") {
    if (rate < lane.minKg) return "fast";
    if (rate > lane.maxKg) return "slow";
    return "in_lane";
  }
  // maintain and bulk share the numeric mapping; the words differ only in copy
  if (rate > lane.maxKg) return "fast";
  if (rate < lane.minKg) return "slow";
  return "in_lane";
}

/* ---------------- generated prose ----------------
 * These strings feed the Trend tab footer and the coach system prompt. They are
 * GENERATED from the same numbers the verdict uses, so the text a user reads and the
 * check a notification runs can never drift apart again. */

// units is display-only: the lane maths stays metric, imperial users just read lb.
export function laneText(phase, weightKg, profile = {}, units = "metric") {
  const lane = laneFor(phase, weightKg, profile);
  const p = phase || "cut";
  if (!lane) {
    return p === "cut"
      ? "Healthy lane: lose 0.5–1.0% of bodyweight per week on the trend."
      : p === "bulk"
      ? "Lean-gain lane: gain 0.1–0.5% of bodyweight per week depending on training age."
      : "Lane: hold within ±0.25% of bodyweight per week.";
  }
  const conv = (kg) => (units === "imperial" ? kgToLb(kg) : kg);
  const unit = units === "imperial" ? "lb" : "kg";
  const lo = fmt2(conv(lane.minKg));
  const hi = fmt2(conv(lane.maxKg));
  if (p === "cut") {
    return `Healthy lane: ${lo} to ${hi} ${unit}/week on the trend. Slower for 2–3 weeks → tighten intake; faster than ${lo} → eat a bit more, the muscle is the point.`;
  }
  if (p === "bulk") {
    return `Lean-gain lane: ${lo} to ${hi} ${unit}/week on the trend. Flat for 2–3 weeks → add a little; faster than ${hi} → trim, the excess is mostly fat.`;
  }
  return `Lane: hold within ${lo} to ${hi} ${unit}/week on the trend while pushing your lifts.`;
}

// Coaching rules for the AI system prompt — same numbers, imperative voice.
export function laneRules(phase, weightKg, profile = {}) {
  const lane = laneFor(phase, weightKg, profile);
  const p = phase || "cut";
  const band = lane ? `${fmt2(lane.minKg)} to ${fmt2(lane.maxKg)} kg/week` : "the phase lane";
  if (p === "cut") {
    return `Phase: CUT. Lane: ${band} on the trend weight. Slower than the lane for 2–3 weeks → advise a modest intake cut or one extra Zone-2 session. Faster than the lane → advise eating slightly more to protect muscle. Protein is the non-negotiable target. Maintaining lifting loads counts as winning.`;
  }
  if (p === "bulk") {
    return `Phase: LEAN BULK. Lane: ${band} on the trend weight. Flat for 2–3 weeks → advise a small intake increase. Faster than the lane → advise trimming, the excess is mostly fat. Primary goal: progressive overload — expect load or rep increases on main lifts most weeks. Protein stays high.`;
  }
  return `Phase: MAINTENANCE. Lane: hold within ${band} on the trend weight. Drifting outside it for 2+ weeks → advise a 100–150 kcal nudge. Primary goal: push lift progression at stable bodyweight and consolidate habits.`;
}

/* ---------------- maintain gauge ---------------- */

// How many consecutive trailing weeks has the rate stayed in the lane? Drives the
// maintenance-phase progress display (a start→goal bar is meaningless when
// start === goal). Steps the trend window back a week at a time until it leaves the
// band or runs out of data.
export function weeksInLane(entries, asOf, phase, profile = {}, maxWeeks = 12) {
  let weeks = 0;
  for (let k = 0; k < maxWeeks; k++) {
    const t = computeTrend(entries, shiftBack(asOf, k * 7));
    if (t.rate == null) break;
    if (laneVerdict(phase, t.rate, t.trendWeight, profile) !== "in_lane") break;
    weeks++;
  }
  return weeks;
}

function shiftBack(date, days) {
  const d = new Date(Date.parse(`${date}T00:00:00Z`) - days * 86400000);
  return d.toISOString().slice(0, 10);
}
