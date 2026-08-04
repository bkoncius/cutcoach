// Table-driven tests for lib/trend.js. Run: node scripts/test-trend.mjs
import assert from "node:assert/strict";
import { computeTrend, trendSeries, shiftDate } from "../lib/trend.js";

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

// Build entries from a start date: values[i] at start+i days; null = no weigh-in.
const daily = (start, values) =>
  values.map((v, i) => (v == null ? null : { date: shiftDate(start, i), weight: v })).filter(Boolean);

console.log("\ncomputeTrend — rate correctness (the core bug this module fixes)");

t("daily logger losing 0.1/day → −0.7 kg/wk", () => {
  const e = daily("2026-08-01", [90, 89.9, 89.8, 89.7, 89.6, 89.5, 89.4, 89.3, 89.2, 89.1, 89, 88.9, 88.8, 88.7]);
  const r = computeTrend(e, "2026-08-14");
  assert.equal(r.confidence, "ok");
  assert.ok(Math.abs(r.rate - -0.7) < 0.01, `rate ${r.rate}`);
});

t("every-other-day logger, same true slope → SAME −0.7, not −1.4 (old math doubled it)", () => {
  // Weighs in on days 0,2,4,...,12 — losing 0.1/day → 0.2 between entries.
  const e = [];
  for (let i = 0; i <= 12; i += 2) e.push({ date: shiftDate("2026-08-01", i), weight: 90 - 0.1 * i });
  const r = computeTrend(e, "2026-08-13");
  assert.equal(r.confidence, "ok", `confidence ${r.confidence} (n=${r.nPoints}, span=${r.spanDays})`);
  assert.ok(Math.abs(r.rate - -0.7) < 0.01, `rate ${r.rate} — sparse logging must not inflate the rate`);
  // The old slice(-7)/slice(-14,-7) math on this same data reported ~2x. Guard the ratio:
  assert.ok(Math.abs(r.rate) < 1.0, "regression guard: must be nowhere near the doubled value");
});

t("noisy but flat maintainer → rate ~0, in ok confidence", () => {
  const noise = [0.3, -0.2, 0.1, -0.4, 0.2, 0.4, -0.1, -0.3, 0.2, -0.2, 0.3, 0.1, -0.3, 0.1];
  const e = noise.map((n, i) => ({ date: shiftDate("2026-08-01", i), weight: 80 + n }));
  const r = computeTrend(e, "2026-08-14");
  assert.equal(r.confidence, "ok");
  assert.ok(Math.abs(r.rate) < 0.25, `rate ${r.rate} should be ≈0`);
});

t("fast loser flagged as such (−1.4/wk data reads −1.4)", () => {
  const e = daily("2026-08-01", Array.from({ length: 14 }, (_, i) => 95 - 0.2 * i));
  const r = computeTrend(e, "2026-08-14");
  assert.ok(Math.abs(r.rate - -1.4) < 0.01, `rate ${r.rate}`);
});

console.log("\ncold start / confidence ladder");

t("no data → insufficient, 4 needed", () => {
  const r = computeTrend([], "2026-08-14");
  assert.equal(r.confidence, "insufficient");
  assert.equal(r.rate, null);
  assert.equal(r.pointsNeeded, 4);
});

t("3 weigh-ins → insufficient, 1 more needed, trend still shown", () => {
  const e = daily("2026-08-01", [90, 89.8, 89.9]);
  const r = computeTrend(e, "2026-08-03");
  assert.equal(r.confidence, "insufficient");
  assert.equal(r.pointsNeeded, 1);
  assert.ok(r.trendWeight != null, "trend weight should exist from the first weigh-in");
});

t("4 points but tight span (4 days) → still insufficient (span gate)", () => {
  const e = daily("2026-08-01", [90, 89.9, 89.8, 89.7]);
  const r = computeTrend(e, "2026-08-04");
  assert.equal(r.confidence, "insufficient");
});

t("5 points across 9 days → low (rate shown with ~, engine must not act)", () => {
  const e = [0, 2, 4, 6, 8].map((i) => ({ date: shiftDate("2026-08-01", i), weight: 90 - 0.1 * i }));
  const r = computeTrend(e, "2026-08-09");
  assert.equal(r.confidence, "low");
  assert.ok(r.rate != null);
});

t("weekend-only logger (2 pts/wk) never reaches ok inside 14 days", () => {
  const e = [0, 1, 7, 8, 14].map((i) => ({ date: shiftDate("2026-08-01", i), weight: 90 - 0.05 * i }));
  const r = computeTrend(e, "2026-08-15");
  assert.notEqual(r.confidence, "ok", `n=${r.nPoints} span=${r.spanDays}`);
});

console.log("\nEWMA behavior");

t("single-day spike is damped in the trend", () => {
  const vals = [80, 80, 80, 80, 80, 83, 80, 80, 80, 80];
  const e = daily("2026-08-01", vals);
  const s = trendSeries(e);
  const spikeDay = s[5];
  assert.ok(spikeDay.trend < 81, `trend ${spikeDay.trend} should absorb most of a 3 kg spike`);
});

t("long gap then resume: gap-exponentiated alpha catches up", () => {
  // 5 daily points at 90, 20-day silence, return at 85.
  const e = [...daily("2026-08-01", [90, 90, 90, 90, 90]), { date: "2026-08-25", weight: 85 }];
  const s = trendSeries(e);
  const last = s[s.length - 1].trend;
  // a = 1 - 0.75^20 ≈ 0.997 → trend should be ≈85, not stuck near 90
  assert.ok(last < 85.2, `trend ${last} should have nearly converged to the new weight`);
});

t("asOf excludes later entries (dispatch replay safety)", () => {
  const e = daily("2026-08-01", [90, 89.9, 89.8, 89.7, 89.6, 89.5, 89.4, 89.3, 89.2, 89.1]);
  const early = computeTrend(e, "2026-08-05");
  assert.equal(early.nPoints, 5);
});

t("duplicate dates: last write wins, no double-count", () => {
  const e = [
    { date: "2026-08-01", weight: 90 },
    { date: "2026-08-01", weight: 89 },
    { date: "2026-08-02", weight: 89.5 },
  ];
  const s = trendSeries(e);
  assert.equal(s.length, 2);
  assert.equal(s[0].weight, 89);
});

t("null/garbage weights dropped without throwing", () => {
  const e = [
    { date: "2026-08-01", weight: null },
    { date: "2026-08-02", weight: "abc" },
    { date: "2026-08-03", weight: 90 },
  ];
  const r = computeTrend(e, "2026-08-03");
  assert.equal(r.nPoints, 1);
  assert.equal(r.trendWeight, 90);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
