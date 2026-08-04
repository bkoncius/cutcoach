// Table-driven tests for lib/lanes.js. Run: node scripts/test-lanes.mjs
import assert from "node:assert/strict";
import { laneFor, laneVerdict, laneText, laneRules, weeksInLane } from "../lib/lanes.js";
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

console.log("\nlaneFor — % of bodyweight resolved to kg");

t("cut at 87 kg → −0.87..−0.44 (continuous with the old −0.5..−0.7 prose)", () => {
  const l = laneFor("cut", 87);
  assert.equal(l.minKg, -0.87);
  assert.equal(l.maxKg, -0.44);
});

t("cut at 60 kg scales down; at 120 kg the fast edge caps at −1.0 abs", () => {
  assert.equal(laneFor("cut", 60).minKg, -0.6);
  assert.equal(laneFor("cut", 120).minKg, -1.0); // −1.2 uncapped → capped
});

t("lean male (BF 12) gets the gentler band", () => {
  const l = laneFor("cut", 80, { bodyfatPct: 12, sex: "male" });
  assert.equal(l.minKg, -0.6); // −0.75% × 80
  assert.equal(l.maxKg, -0.28);
});

t("female lean threshold differs (BF 20 is lean for F, not for the unspecified midpoint)", () => {
  const f = laneFor("cut", 70, { bodyfatPct: 20, sex: "female" });
  assert.equal(f.minKg, -0.53); // lean band
  const u = laneFor("cut", 70, { bodyfatPct: 20, sex: "unspecified" });
  assert.equal(u.minKg, -0.7); // 20 ≥ 19 midpoint → standard band
});

t("bulk band scales by experience, not size", () => {
  assert.equal(laneFor("bulk", 80, { experience: "beginner" }).maxKg, 0.4);
  assert.equal(laneFor("bulk", 80, { experience: "advanced" }).maxKg, 0.2);
  assert.equal(laneFor("bulk", 80, {}).maxKg, 0.28); // default intermediate
});

t("no weight → null lane", () => {
  assert.equal(laneFor("cut", null), null);
  assert.equal(laneFor("cut", 0), null);
});

console.log("\nlaneVerdict — the contradictions the old onTrack had");

t("cut: −0.1 kg/wk is SLOW, not on-track (old code accepted any negative)", () => {
  assert.equal(laneVerdict("cut", -0.1, 87), "slow");
});
t("cut: −1.8 kg/wk is FAST (old code called it fine)", () => {
  assert.equal(laneVerdict("cut", -1.8, 87), "fast");
});
t("cut: −0.6 at 87 kg is in lane", () => {
  assert.equal(laneVerdict("cut", -0.6, 87), "in_lane");
});
t("bulk: +2.0 kg/wk is FAST (old code accepted any positive)", () => {
  assert.equal(laneVerdict("bulk", 2.0, 80), "fast");
});
t("maintain: band edges at 80 kg are ±0.2", () => {
  assert.equal(laneVerdict("maintain", 0.15, 80), "in_lane");
  assert.equal(laneVerdict("maintain", 0.3, 80), "fast");
  assert.equal(laneVerdict("maintain", -0.3, 80), "slow");
});
t("null rate or weight → unknown", () => {
  assert.equal(laneVerdict("cut", null, 87), "unknown");
  assert.equal(laneVerdict("cut", -0.5, null), "unknown");
});

console.log("\ngenerated prose carries the resolved numbers");

t("laneText embeds the kg band", () => {
  const s = laneText("cut", 87);
  assert.match(s, /−0\.87/);
  assert.match(s, /−0\.44/);
});
t("laneRules embeds the same numbers (prompt can't drift from verdict)", () => {
  const s = laneRules("cut", 87);
  assert.match(s, /−0\.87 to −0\.44/);
});
t("no-weight fallback prose is % based", () => {
  assert.match(laneText("cut", null), /0\.5–1\.0%/);
});

console.log("\nweeksInLane — the maintenance gauge");

t("6 weeks of flat data → counts weeks until data runs out", () => {
  const e = [];
  for (let i = 0; i < 42; i++) e.push({ date: shiftDate("2026-07-01", i), weight: 80 + (i % 3 === 0 ? 0.2 : -0.1) });
  const w = weeksInLane(e, "2026-08-11", "maintain", {});
  assert.ok(w >= 3, `weeks ${w} — flat noisy data should count several weeks in lane`);
});

t("recent drift breaks the streak at week zero", () => {
  const e = [];
  // 3 flat weeks then a sharp 2-week rise of ~0.5/wk
  for (let i = 0; i < 21; i++) e.push({ date: shiftDate("2026-07-01", i), weight: 80 });
  for (let i = 21; i < 35; i++) e.push({ date: shiftDate("2026-07-01", i), weight: 80 + (i - 20) * 0.07 });
  const w = weeksInLane(e, "2026-08-04", "maintain", {});
  assert.equal(w, 0, `weeks ${w} — current drift must zero the streak`);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
