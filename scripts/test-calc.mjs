// Tests for lib/calc.js + lib/units.js. Run: node scripts/test-calc.mjs
import assert from "node:assert/strict";
import {
  bmr, ageFrom, formulaTdee, suggestTargets, proteinTarget, checkGoal, etaRange, KCAL_FLOOR,
} from "../lib/calc.js";
import { kgToLb, lbToKg, parseWeightInput, ftInToCm, cmToFtIn, formatWeight } from "../lib/units.js";

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

console.log("\nMifflin-St Jeor — hand-checked values");
t("male 87 kg / 182 cm / 30 y → 1863", () => {
  // 10×87 + 6.25×182 − 5×30 + 5 = 870 + 1137.5 − 150 + 5 = 1862.5
  assert.equal(bmr({ sex: "male", weightKg: 87, heightCm: 182, age: 30 }), 1863);
});
t("female same stats → 1697 (sex term −161)", () => {
  assert.equal(bmr({ sex: "female", weightKg: 87, heightCm: 182, age: 30 }), 1697);
});
t("unspecified takes the midpoint (−78)", () => {
  assert.equal(bmr({ sex: "unspecified", weightKg: 87, heightCm: 182, age: 30 }), 1780);
});
t("garbage inputs → null, not NaN", () => {
  assert.equal(bmr({ sex: "male", weightKg: null, heightCm: 182, age: 30 }), null);
});

console.log("\nage from birthdate");
t("birthday not yet passed this year", () => {
  assert.equal(ageFrom("1997-12-31", new Date("2026-07-24T00:00:00Z")), 28);
});
t("birthday passed", () => {
  assert.equal(ageFrom("1997-01-15", new Date("2026-07-24T00:00:00Z")), 29);
});

console.log("\nTDEE + suggested targets");
const benas = { sex: "male", birthdate: "1997-01-15", heightCm: 182, activityLevel: "moderate" };
t("moderate male 87 kg → TDEE ≈ 2888, cut lands mid-lane below it", () => {
  const s = suggestTargets(benas, 87, "cut");
  assert.ok(Math.abs(s.tdee - 2888) <= 10, `tdee ${s.tdee}`);
  // delta = clamp(8.25×87 = 718, 300, 750) → 718; 2888−718 = 2170 → round50 = 2150|2200
  assert.ok(s.kcalTarget >= 2100 && s.kcalTarget <= 2250, `kcal ${s.kcalTarget}`);
  assert.equal(s.floorApplied, false);
  assert.equal(s.proteinTarget, 175); // 2.0 g/kg × 87 = 174 → round5 = 175
});
t("maintain = TDEE rounded", () => {
  const s = suggestTargets(benas, 87, "maintain");
  assert.ok(Math.abs(s.kcalTarget - s.tdee) <= 25);
});
t("small sedentary female cut clamps to the 1200 floor", () => {
  const s = suggestTargets(
    { sex: "female", birthdate: "1981-05-01", heightCm: 160, activityLevel: "sedentary" },
    55,
    "cut"
  );
  assert.equal(s.kcalTarget, KCAL_FLOOR.female);
  assert.equal(s.floorApplied, true);
});
t("deficit capped at 25% of TDEE before the absolute floor", () => {
  const s = suggestTargets(
    { sex: "male", birthdate: "1996-01-01", heightCm: 190, activityLevel: "sedentary" },
    140,
    "cut"
  );
  // 8.25×140 = 1155 → clamped 750; but 25% cap must bind if larger
  assert.ok(s.kcalTarget >= Math.round(s.tdee * 0.75) - 25, `kcal ${s.kcalTarget} vs tdee ${s.tdee}`);
});
t("high body fat switches protein to lean-mass basis", () => {
  // 100 kg at 40% BF: 2.2 × 60 = 132 vs 2.0 × 100 = 200 g/kg-total
  assert.equal(proteinTarget("cut", 100, 40), 130);
  assert.equal(proteinTarget("cut", 100, null), 200);
});
t("protein never below 100 g", () => {
  assert.equal(proteinTarget("bulk", 45, null), 100);
});

console.log("\ngoal sanity");
t("cut goal above current is blocked", () => {
  assert.equal(checkGoal({ phase: "cut", currentKg: 80, goalKg: 85, heightCm: 180 }).ok, false);
});
t("goal under BMI 17.5 is blocked", () => {
  const r = checkGoal({ phase: "cut", currentKg: 70, goalKg: 52, heightCm: 175 }); // BMI 17.0
  assert.equal(r.ok, false);
});
t("goal under BMI 18.5 warns but allows", () => {
  const r = checkGoal({ phase: "cut", currentKg: 70, goalKg: 56, heightCm: 175 }); // BMI 18.3
  assert.equal(r.ok, true);
  assert.ok(r.warning);
});
t(">25% loss warns", () => {
  const r = checkGoal({ phase: "cut", currentKg: 120, goalKg: 85, heightCm: 180 });
  assert.equal(r.ok, true);
  assert.ok(r.warning);
});
t("maintain always ok", () => {
  assert.equal(checkGoal({ phase: "maintain", currentKg: 80, goalKg: 80, heightCm: 180 }).ok, true);
});

console.log("\netaRange");
t("12 kg cut at 87 kg → ~14..28 weeks", () => {
  const r = etaRange("cut", 87, 75, {});
  assert.ok(r.minWeeks >= 13 && r.minWeeks <= 15, `min ${r.minWeeks}`);
  assert.ok(r.maxWeeks >= 26 && r.maxWeeks <= 30, `max ${r.maxWeeks}`);
});

console.log("\nunits — storage is always metric");
t("kg↔lb round trip", () => {
  assert.ok(Math.abs(lbToKg(kgToLb(87)) - 87) < 1e-9);
  assert.ok(Math.abs(kgToLb(87) - 191.8) < 0.05);
});
t("parseWeightInput converts imperial input to kg", () => {
  assert.ok(Math.abs(parseWeightInput("185", "imperial") - 83.9) < 0.05);
  assert.ok(Math.abs(parseWeightInput("86,4", "metric") - 86.4) < 1e-9); // comma decimals
});
t("height ft/in ↔ cm", () => {
  assert.equal(ftInToCm(6, 0), 182.9);
  const { ft, inch } = cmToFtIn(182.9);
  assert.equal(ft, 6);
  assert.equal(inch, 0);
});
t("formatWeight renders display units", () => {
  assert.equal(formatWeight(87, "metric"), "87.0");
  assert.equal(formatWeight(87, "imperial"), "191.8");
  assert.equal(formatWeight(null, "metric"), "—");
});

console.log(`\n${pass} passed, ${fail} failed\n`);
