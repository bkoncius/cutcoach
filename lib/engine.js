// The adaptive calorie engine. Pure and isomorphic: the dispatcher runs it weekly to
// AUTHOR proposals (server is the only authority), and the client re-runs it read-only
// for live Trend-tab tiles. Same module, no divergence.
//
// Design stance (locked): DETERMINISTIC. The engine computes; the AI coach only
// narrates its output. Every rule below is a number, not a vibe, and the reason
// string it emits is the card copy and the thing the coach explains.

import { computeTrend } from "./trend.js";
import { laneFor, laneVerdict } from "./lanes.js";
import { formulaTdee, KCAL_FLOOR, proteinTarget as proteinFor } from "./calc.js";

export const ENGINE_WINDOW_DAYS = 21;
// Below these, an energy-balance TDEE has a confidence interval wider than ±500 kcal —
// noise dressed as science. The blend weight (not the gate) covers the in-between.
export const MIN_COMPLETE_DAYS = 8;
export const MIN_WEIGH_INS = 6;
export const MIN_WEIGH_SPAN = 14;
export const MIN_PHASE_AGE_DAYS = 14;
export const MIN_DAYS_SINCE_CHANGE = 7;
export const STEP_MIN = 100; // below this: hold, "within noise"
export const STEP_MAX = 200; // deliberate under-correction; consecutive weeks converge
const KCAL_PER_KG = 7700;

const DAY_MS = 86400000;
const toUTC = (d) => Date.parse(`${d}T00:00:00Z`);
const daysBetween = (a, b) => Math.round((toUTC(b) - toUTC(a)) / DAY_MS);
const round50 = (n) => Math.round(n / 50) * 50;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// The user's local Monday for a given local date — the week key the unique claim
// rides on. Computed from the LOCAL date string, never UTC (a UTC boundary would
// double- or zero-fire for UTC+13 users).
export function weekStartFor(localDate) {
  const d = new Date(toUTC(localDate));
  const dow = d.getUTCDay(); // 0=Sun
  const back = (dow + 6) % 7; // Mon→0, Sun→6
  return new Date(toUTC(localDate) - back * DAY_MS).toISOString().slice(0, 10);
}

/**
 * runEngine — evaluate one user's week.
 *
 * inputs: {
 *   weights:  [{date, weight}]                      // ≥ ENGINE_WINDOW_DAYS back
 *   intake:   [{date, kcal, complete}]              // per-day totals
 *   profile:  {sex, birthdate, heightCm, activityLevel, bodyfatPct, experience}
 *   targets:  {kcal, protein, phase, phaseStartedAt, proteinSetAtWeight}
 *   prevWeekOutOfBand: boolean                      // maintain's 2-week confirmation
 *   lastAppliedAt: "YYYY-MM-DD" | null              // last applied target change
 *   asOf: "YYYY-MM-DD"                              // local date
 * }
 *
 * -> {
 *   verdict, confidence, trendWeight, rate,
 *   tdeeFormula, tdeeAdaptive, tdeeBlended, blendWeight,
 *   completeDays, weighIns, spanDays,
 *   proposal: {newKcal, step, newProtein?, reason} | null,
 *   holdReason: string | null,     // why there's no proposal (status 'none' copy)
 * }
 */
export function runEngine({ weights, intake, profile, targets, prevWeekOutOfBand = false, lastAppliedAt = null, asOf }) {
  const trend = computeTrend(weights, asOf, { windowDays: ENGINE_WINDOW_DAYS });
  const { trendWeight, rate } = trend;

  const from = new Date(toUTC(asOf) - (ENGINE_WINDOW_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);
  const windowIntake = (intake || []).filter((d) => d.date >= from && d.date <= asOf);
  const completeDays = windowIntake.filter((d) => d.complete && Number(d.kcal) > 0);
  const meanIntake = completeDays.length
    ? completeDays.reduce((s, d) => s + Number(d.kcal), 0) / completeDays.length
    : null;

  const tdeeFormula = formulaTdee(profile, trendWeight);
  const weighSpan = trend.spanDays;

  // Energy balance: what you ate minus what the scale says you banked.
  const dataGateMet =
    completeDays.length >= MIN_COMPLETE_DAYS &&
    trend.nPoints >= MIN_WEIGH_INS &&
    weighSpan >= MIN_WEIGH_SPAN &&
    rate != null &&
    meanIntake != null;

  let tdeeAdaptiveRaw = null;
  let tdeeAdaptive = null;
  let underreporting = false;
  if (dataGateMet) {
    tdeeAdaptiveRaw = Math.round(meanIntake - (rate / 7) * KCAL_PER_KG);
    if (tdeeFormula != null) {
      // The classic death spiral: under-logging → absurdly low apparent TDEE → engine
      // cuts calories → repeat. Clamp to formula ±30% and flag when the raw value
      // says intake can't explain the trend.
      underreporting = tdeeAdaptiveRaw < tdeeFormula * 0.7;
      tdeeAdaptive = clamp(tdeeAdaptiveRaw, Math.round(tdeeFormula * 0.7), Math.round(tdeeFormula * 1.3));
    } else {
      tdeeAdaptive = tdeeAdaptiveRaw;
    }
  }

  // Confidence-weighted blend: pure formula with no data, pure measurement with
  // 14 complete days across a 21-day span.
  const blendWeight = dataGateMet
    ? clamp((completeDays.length - 4) / 10, 0, 1) * clamp((weighSpan - 7) / 14, 0, 1)
    : 0;
  const tdeeBlended =
    tdeeAdaptive != null && tdeeFormula != null
      ? Math.round(blendWeight * tdeeAdaptive + (1 - blendWeight) * tdeeFormula)
      : tdeeFormula;

  const verdict = laneVerdict(targets.phase, rate, trendWeight, profile);

  const base = {
    verdict,
    confidence: trend.confidence,
    trendWeight,
    rate,
    tdeeFormula,
    tdeeAdaptive,
    tdeeBlended,
    blendWeight: Math.round(blendWeight * 100) / 100,
    completeDays: completeDays.length,
    weighIns: trend.nPoints,
    spanDays: weighSpan,
    proposal: null,
    holdReason: null,
  };

  const hold = (why) => ({ ...base, holdReason: why });

  /* ---------- preconditions, cheapest first ---------- */

  if (targets.kcal == null || targets.protein == null) {
    return hold("no targets set — finish onboarding first");
  }
  const phaseAge = targets.phaseStartedAt ? daysBetween(targets.phaseStartedAt, asOf) : null;
  if (phaseAge != null && phaseAge < MIN_PHASE_AGE_DAYS) {
    return hold(`new phase — giving it ${MIN_PHASE_AGE_DAYS - phaseAge} more day${MIN_PHASE_AGE_DAYS - phaseAge === 1 ? "" : "s"} to settle before judging`);
  }
  if (lastAppliedAt != null && daysBetween(lastAppliedAt, asOf) < MIN_DAYS_SINCE_CHANGE) {
    return hold("targets changed less than a week ago — measuring the response first");
  }
  if (rate == null || trend.confidence === "insufficient") {
    return hold("not enough weigh-ins for a trustworthy trend — aim for most mornings this week");
  }
  if (!dataGateMet) {
    const needDays = Math.max(0, MIN_COMPLETE_DAYS - completeDays.length);
    return hold(
      needDays > 0
        ? `only ${completeDays.length} fully-logged day${completeDays.length === 1 ? "" : "s"} in 3 weeks — mark days complete on the Food tab (need ${MIN_COMPLETE_DAYS})`
        : "not enough weigh-in coverage across the window yet"
    );
  }
  if (trend.confidence === "low") {
    return hold("trend confidence is low this week — holding rather than adjusting on noise");
  }

  /* ---------- the decision ---------- */

  const lane = laneFor(targets.phase, trendWeight, profile);
  if (!lane) return hold("no trend weight to size the lane against");

  // Protein rescale rides along with any outcome when bodyweight has moved.
  const proteinAnchor = targets.proteinSetAtWeight;
  const newProtein =
    proteinAnchor != null && trendWeight != null && Math.abs(trendWeight - proteinAnchor) >= 2.5
      ? proteinFor(targets.phase, trendWeight, profile?.bodyfatPct)
      : null;
  const proteinPart =
    newProtein != null && newProtein !== targets.protein
      ? ` Protein moves to ${newProtein} g for your current weight.`
      : "";
  const withProtein = (p) =>
    newProtein != null && newProtein !== targets.protein ? { ...p, newProtein } : p;

  if (verdict === "in_lane") {
    if (underreporting) {
      return hold("in the lane, but logged intake can't explain the trend — the calorie numbers are likely under-logged; tighten logging before trusting them");
    }
    // In-lane protein-only update still surfaces as a (gentle) proposal.
    if (newProtein != null && newProtein !== targets.protein) {
      return {
        ...base,
        proposal: withProtein({
          newKcal: targets.kcal,
          step: 0,
          reason: `Right in the lane at ${fmtRate(rate)} — calories hold at ${targets.kcal}.${proteinPart}`,
        }),
      };
    }
    return hold(`in the lane at ${fmtRate(rate)} — no change needed`);
  }

  // Out of lane. Maintain requires two consecutive out-of-band weeks — one odd week
  // is water, travel, or life, and the old prose said exactly this without any code
  // enforcing it.
  if (targets.phase === "maintain" && !prevWeekOutOfBand) {
    return hold(`drifted ${fmtRate(rate)} this week — one week can be noise; confirming next week before adjusting`);
  }

  // Never propose a cut the data says is phantom.
  const wantsDown = rate > lane.midKg; // losing too slowly / gaining too fast → eat less
  if (wantsDown && underreporting) {
    return hold("the trend says eat less, but logged intake is far below what the scale implies — likely under-logging; fix the logging first, not the target");
  }

  const neededPerDay = ((lane.midKg - rate) / 7) * KCAL_PER_KG; // negative → cut kcal
  if (Math.abs(neededPerDay) < STEP_MIN) {
    return hold(`within noise of the lane (${fmtRate(rate)}) — holding`);
  }
  const step = Math.sign(neededPerDay) * clamp(round50(Math.abs(neededPerDay)), STEP_MIN, STEP_MAX);
  let newKcal = targets.kcal + step;

  // Floors, re-checked at apply-size: absolute floor by sex, and never below 75% of
  // blended TDEE.
  const floor = Math.max(KCAL_FLOOR[profile?.sex] ?? KCAL_FLOOR.unspecified, Math.round((tdeeBlended || 0) * 0.75));
  if (step < 0 && newKcal < floor) {
    if (targets.kcal <= floor) {
      return hold("already at the safe minimum — the lever now is activity and adherence, not fewer calories");
    }
    newKcal = floor;
  }
  newKcal = round50(newKcal);
  if (newKcal === targets.kcal) {
    return hold(`the sized step rounds to no change (${fmtRate(rate)}) — holding`);
  }

  const actualStep = newKcal - targets.kcal;
  const dir = verdict === "slow" ? "slower than the lane" : "faster than the lane";
  const reason =
    `Trend ${fmtKg(trendWeight)} moving ${fmtRate(rate)} — ${dir} (${fmtRate(lane.minKg)} to ${fmtRate(lane.maxKg)}). ` +
    `Measured burn ≈ ${tdeeBlended} kcal/day (${Math.round(blendWeight * 100)}% from your own data, ${completeDays.length} complete days). ` +
    `${actualStep > 0 ? "+" : ""}${actualStep} kcal/day points the trend back at the middle of the lane.${proteinPart}`;

  return { ...base, proposal: withProtein({ newKcal, step: actualStep, reason }) };
}

const fmtKg = (n) => `${(Math.round(n * 10) / 10).toFixed(1)} kg`;
const fmtRate = (n) => `${n > 0 ? "+" : ""}${(Math.round(n * 100) / 100).toFixed(2)} kg/wk`;
