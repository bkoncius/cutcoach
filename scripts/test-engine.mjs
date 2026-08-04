// Table-driven tests for lib/engine.js. Run: node scripts/test-engine.mjs
import assert from "node:assert/strict";
import { runEngine, weekStartFor, STEP_MAX } from "../lib/engine.js";
import { shiftDate } from "../lib/trend.js";

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
};

const ASOF = "2026-08-24"; // a Monday
const START = shiftDate(ASOF, -20); // 21-day window start

// Daily weights from `start`, slope kg/day; daily intake kcal with completeness.
const series = (startW, slopePerDay, days = 21, everyN = 1) => {
  const out = [];
  for (let i = 0; i < days; i += everyN) out.push({ date: shiftDate(START, i), weight: +(startW + slopePerDay * i).toFixed(2) });
  return out;
};
const intakeFlat = (kcal, completeDays = 21) => {
  const out = [];
  for (let i = 0; i < 21; i++) out.push({ date: shiftDate(START, i), kcal, complete: i < completeDays });
  return out;
};

const PROFILE = { sex: "male", birthdate: "1997-01-15", heightCm: 182, activityLevel: "moderate" };
const CUT = (kcal = 2200) => ({
  kcal, protein: 175, phase: "cut", phaseStartedAt: shiftDate(ASOF, -60), proteinSetAtWeight: 87,
});

console.log("\nweekStartFor — the claim key");
t("Monday maps to itself; Sunday maps back 6", () => {
  assert.equal(weekStartFor("2026-08-24"), "2026-08-24"); // Mon
  assert.equal(weekStartFor("2026-08-30"), "2026-08-24"); // Sun
  assert.equal(weekStartFor("2026-08-25"), "2026-08-24"); // Tue
});

console.log("\npreconditions hold instead of proposing");
t("sparse logging: gate blocks with an actionable reason", () => {
  const r = runEngine({
    weights: series(87, -0.09), intake: intakeFlat(2200, 3), profile: PROFILE, targets: CUT(), asOf: ASOF,
  });
  assert.equal(r.proposal, null);
  assert.match(r.holdReason, /fully-logged day/);
});
t("young phase: held even with perfect data", () => {
  const r = runEngine({
    weights: series(87, -0.09), intake: intakeFlat(2200), profile: PROFILE,
    targets: { ...CUT(), phaseStartedAt: shiftDate(ASOF, -5) }, asOf: ASOF,
  });
  assert.equal(r.proposal, null);
  assert.match(r.holdReason, /new phase/);
});
t("recent target change: held", () => {
  const r = runEngine({
    weights: series(87, -0.09), intake: intakeFlat(2200), profile: PROFILE,
    targets: CUT(), lastAppliedAt: shiftDate(ASOF, -3), asOf: ASOF,
  });
  assert.match(r.holdReason, /less than a week/);
});
t("cold start (3 weigh-ins): held on trend confidence", () => {
  const r = runEngine({
    weights: series(87, -0.09, 21, 8), intake: intakeFlat(2200), profile: PROFILE, targets: CUT(), asOf: ASOF,
  });
  assert.equal(r.proposal, null);
});
t("no targets (pre-onboarding): held, engine never invents", () => {
  const r = runEngine({
    weights: series(87, -0.09), intake: intakeFlat(2200), profile: PROFILE,
    targets: { kcal: null, protein: null, phase: "cut" }, asOf: ASOF,
  });
  assert.match(r.holdReason, /onboarding/);
});

console.log("\nverdicts and proposals");
t("textbook cut on target → in lane, no change", () => {
  // 87 kg, −0.09/day ≈ −0.63/wk — inside −0.87..−0.44
  const r = runEngine({
    weights: series(87, -0.09), intake: intakeFlat(2200), profile: PROFILE, targets: CUT(), asOf: ASOF,
  });
  assert.equal(r.verdict, "in_lane");
  assert.equal(r.proposal, null);
  assert.match(r.holdReason, /in the lane/);
});
t("slow cut → negative step, capped at 200, reason carries the numbers", () => {
  // −0.02/day ≈ −0.14/wk: way slower than the −0.66 mid → wants a big cut, capped.
  const r = runEngine({
    weights: series(87, -0.02), intake: intakeFlat(2600), profile: PROFILE, targets: CUT(2600), asOf: ASOF,
  });
  assert.equal(r.verdict, "slow");
  assert.ok(r.proposal, `expected a proposal, got hold: ${r.holdReason}`);
  assert.equal(r.proposal.step, -STEP_MAX);
  assert.equal(r.proposal.newKcal, 2400);
  assert.match(r.proposal.reason, /slower than the lane/);
  assert.match(r.proposal.reason, /kcal\/day points the trend back/);
});
t("fast cut → positive step (protect muscle)", () => {
  // −0.2/day = −1.4/wk: faster than −0.87 floor
  const r = runEngine({
    weights: series(87, -0.2), intake: intakeFlat(1800), profile: PROFILE, targets: CUT(1800), asOf: ASOF,
  });
  assert.equal(r.verdict, "fast");
  assert.ok(r.proposal);
  assert.ok(r.proposal.step > 0, `step ${r.proposal.step} should be positive`);
});
t("three simulated weeks of slow cut converge without oscillating", () => {
  let kcal = 2600;
  let slope = -0.02;
  for (let week = 0; week < 3; week++) {
    const r = runEngine({
      weights: series(87 + slope * 0, slope), intake: intakeFlat(kcal), profile: PROFILE,
      targets: { ...CUT(kcal) }, asOf: ASOF,
    });
    if (!r.proposal) break;
    assert.ok(Math.abs(r.proposal.step) <= STEP_MAX);
    kcal = r.proposal.newKcal;
    // each −200 kcal/day ≈ −0.18 kg/wk more loss
    slope -= (200 / 7700);
  }
  assert.ok(kcal <= 2200 && kcal >= 2000, `after 3 weeks kcal=${kcal} — should approach the lane, not blow past it`);
});

console.log("\nthe underreporter guard (the death-spiral blocker)");
t("logged 1400 but barely losing → NO downward proposal, logging called out", () => {
  // Slow loss says "cut more", but intake 1400 vs formula ~2900 is not credible.
  const r = runEngine({
    weights: series(87, -0.02), intake: intakeFlat(1400), profile: PROFILE, targets: CUT(1400), asOf: ASOF,
  });
  assert.equal(r.proposal, null);
  assert.match(r.holdReason, /under-logging/);
});
t("adaptive TDEE is clamped to formula ±30%", () => {
  const r = runEngine({
    weights: series(87, -0.02), intake: intakeFlat(1400), profile: PROFILE, targets: CUT(1400), asOf: ASOF,
  });
  assert.ok(r.tdeeAdaptive >= r.tdeeFormula * 0.7 - 1, `${r.tdeeAdaptive} vs formula ${r.tdeeFormula}`);
});

console.log("\nmaintain: two-week confirmation");
const MAINTAIN = { kcal: 2750, protein: 160, phase: "maintain", phaseStartedAt: shiftDate(ASOF, -90), proteinSetAtWeight: 80 };
t("one drifting week → held for confirmation", () => {
  const r = runEngine({
    weights: series(80, 0.06), intake: intakeFlat(2900), profile: PROFILE,
    targets: MAINTAIN, prevWeekOutOfBand: false, asOf: ASOF,
  });
  assert.equal(r.proposal, null);
  assert.match(r.holdReason, /confirming next week/);
});
t("second drifting week → proposes the trim", () => {
  const r = runEngine({
    weights: series(80, 0.06), intake: intakeFlat(2900), profile: PROFILE,
    targets: MAINTAIN, prevWeekOutOfBand: true, asOf: ASOF,
  });
  assert.ok(r.proposal, `got hold: ${r.holdReason}`);
  assert.ok(r.proposal.step < 0);
});

console.log("\nfloors");
t("small sedentary female at the floor → hold with the right message", () => {
  const r = runEngine({
    weights: series(58, -0.005), // barely moving
    intake: intakeFlat(1200),
    profile: { sex: "female", birthdate: "1981-05-01", heightCm: 158, activityLevel: "sedentary" },
    targets: { kcal: 1200, protein: 120, phase: "cut", phaseStartedAt: shiftDate(ASOF, -60), proteinSetAtWeight: 58 },
    asOf: ASOF,
  });
  assert.equal(r.proposal, null);
  assert.match(r.holdReason, /safe minimum|under-logging/);
});

console.log("\nprotein rescale");
t("−3 kg since protein was set → new protein rides along", () => {
  const r = runEngine({
    weights: series(84, -0.09), intake: intakeFlat(2100), profile: PROFILE,
    targets: { ...CUT(2100), proteinSetAtWeight: 87 }, asOf: ASOF,
  });
  // in lane → protein-only proposal (step 0) or hold if protein unchanged
  if (r.proposal) {
    assert.equal(r.proposal.step, 0);
    assert.ok(r.proposal.newProtein >= 160 && r.proposal.newProtein <= 170, `protein ${r.proposal.newProtein}`);
  } else {
    assert.match(r.holdReason, /in the lane/);
  }
});

console.log(`\n${pass} passed, ${fail} failed\n`);
