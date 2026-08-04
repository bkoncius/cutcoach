// Tests for lib/reminders.js — time windows, conditions, copy. Run: node scripts/test-reminders.mjs
import assert from "node:assert/strict";
import {
  localParts, isDue, onTrack, parseHM, REMINDER_BY_ID, DEFAULT_REMINDERS, GRACE_MINUTES,
} from "../lib/reminders.js";

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

const build = (id, ctx, cfg) => REMINDER_BY_ID[id].build(ctx, cfg || REMINDER_BY_ID[id].defaults);

console.log("\nlocalParts — must reproduce the client's todayKey() exactly");
t("Vilnius is UTC+3 in July", () => {
  const p = localParts(new Date("2026-07-16T05:30:00Z"), "Europe/Vilnius");
  assert.equal(p.date, "2026-07-16");
  assert.equal(p.minutes, 8 * 60 + 30);
});
t("R10: midnight is 0 minutes, not 1440, and rolls the date", () => {
  const p = localParts(new Date("2026-07-16T21:00:00Z"), "Europe/Vilnius");
  assert.equal(p.minutes, 0, `midnight gave ${p.minutes}`);
  assert.equal(p.date, "2026-07-17");
});
t("23:59 local is 1439", () => {
  const p = localParts(new Date("2026-07-16T20:59:00Z"), "Europe/Vilnius");
  assert.equal(p.minutes, 1439);
});
t("negative offset crosses the date line backwards", () => {
  const p = localParts(new Date("2026-07-16T03:00:00Z"), "America/Los_Angeles");
  assert.equal(p.date, "2026-07-15");
});
t("invalid zone -> null, not a throw", () => {
  assert.equal(localParts(new Date(), "Not/AZone"), null);
});

console.log("\nparseHM / isDue — the grace window");
t("parseHM bounds", () => {
  assert.equal(parseHM("07:30"), 450);
  assert.equal(parseHM("25:00"), null);
  assert.equal(parseHM("bogus"), null);
});
t("window: [t, t+GRACE)", () => {
  assert.equal(isDue(450, "07:30"), true);
  assert.equal(isDue(450 + GRACE_MINUTES - 1, "07:30"), true);
  assert.equal(isDue(450 + GRACE_MINUTES, "07:30"), false);
  assert.equal(isDue(449, "07:30"), false);
});

console.log("\nonTrack — now lane-aware via lib/lanes.js (weight-dependent)");
t("cut at 87 kg: −0.6 in lane, −0.1 NOT (old code accepted any negative)", () => {
  assert.equal(onTrack("cut", -0.6, 87), true);
  assert.equal(onTrack("cut", -0.1, 87), false);
});
t("cut: −1.8 is off the lane (too fast)", () => {
  assert.equal(onTrack("cut", -1.8, 87), false);
});
t("bulk at 80 kg: +0.25 in lane, +2.0 NOT (old code accepted any positive)", () => {
  assert.equal(onTrack("bulk", 0.25, 80), true);
  assert.equal(onTrack("bulk", 2.0, 80), false);
});
t("no rate or no weight reads as fine (unknown)", () => {
  assert.equal(onTrack("cut", null, 87), true);
  assert.equal(onTrack("cut", -0.6, null), true);
});

console.log("\nweigh_in");
t("skips when already logged", () => {
  assert.equal(build("weigh_in", { weightToday: 84.2 }), null);
});
t("generic copy before there's a trend", () => {
  const n = build("weigh_in", { weightToday: null, trendWeight: null, weeklyRate: null });
  assert.match(n.body, /Step on the scale/);
});
t("interpolates trend + rate, on-lane at 84 kg", () => {
  const n = build("weigh_in", { weightToday: null, trendWeight: 84.34, weeklyRate: -0.6, phase: "cut" });
  assert.match(n.body, /Trend 84\.3 kg/);
  assert.match(n.body, /−0\.6 kg\/wk/);
  assert.match(n.body, /Right in the lane/);
});
t("slow cut reads off the lane now (the fixed contradiction)", () => {
  const n = build("weigh_in", { weightToday: null, trendWeight: 84.3, weeklyRate: -0.1, phase: "cut" });
  assert.match(n.body, /Off the lane/);
});

console.log("\nprotein");
t("skips at/above 50% pace and on zero target", () => {
  assert.equal(build("protein", { proteinToday: 90, proteinTarget: 175 }), null);
  assert.equal(build("protein", { proteinToday: 0, proteinTarget: 0, mealCount: 0 }), null);
});
t("fires below pace with real numbers", () => {
  const n = build("protein", { proteinToday: 62, proteinTarget: 175, mealCount: 2, kcalTarget: 2200 });
  assert.equal(n.title, "62 / 175 g protein");
  assert.match(n.body, /113 g to go/);
});

console.log("\ntrain — gap mode");
t("skips when trained today or inside the gap", () => {
  assert.equal(build("train", { trainedToday: true, daysSinceWorkout: 0 }), null);
  assert.equal(build("train", { trainedToday: false, daysSinceWorkout: 1 }, { gapDays: 2 }), null);
});
t("fires at the gap with next template + last lift", () => {
  const n = build("train", {
    trainedToday: false, daysSinceWorkout: 3, nextTemplate: "lowerB", lastMainLift: "Deadlift 140×5",
  }, { gapDays: 2 });
  assert.equal(n.title, "3 days since you trained");
  assert.match(n.body, /Lower B is up — last Deadlift 140×5/);
});

console.log("\ncheckin");
t("skips when already checked in", () => {
  assert.equal(build("checkin", { lastCheckin: "2026-07-16", localDate: "2026-07-16" }), null);
});
t("fires with the day's numbers", () => {
  const n = build("checkin", {
    lastCheckin: null, localDate: "2026-07-16",
    kcalToday: 2140, kcalTarget: 2200, proteinToday: 168, proteinTarget: 175,
    trainedToday: true, todayTemplate: "upperA",
  });
  assert.match(n.body, /2140\/2200 kcal · 168\/175 g protein · trained Upper A/);
});

console.log("\ndefaults");
t("weigh_in + checkin ship on; protein + train ship off", () => {
  assert.equal(DEFAULT_REMINDERS.weigh_in.enabled, true);
  assert.equal(DEFAULT_REMINDERS.checkin.enabled, true);
  assert.equal(DEFAULT_REMINDERS.protein.enabled, false);
  assert.equal(DEFAULT_REMINDERS.train.enabled, false);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
