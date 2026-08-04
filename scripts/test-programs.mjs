// Tests for lib/programs.js. Run: node scripts/test-programs.mjs
import assert from "node:assert/strict";
import {
  LIBRARY, DEFAULT_PROGRAM_ID, getTemplate, nextTemplateFor, selectProgram, sequenceFor, finisherFor,
} from "../lib/programs.js";

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

console.log("\nlibrary integrity");
t("ul4-gym keeps the legacy template ids verbatim", () => {
  assert.deepEqual(LIBRARY["ul4-gym"].sequence, ["lowerA", "upperA", "lowerB", "upperB"]);
  assert.equal(LIBRARY["ul4-gym"].templates.lowerA.exercises[0].name, "Back Squat");
});
t("every template: unique exercise ids, ≥4 exercises, every sequence id resolves", () => {
  for (const [pid, p] of Object.entries(LIBRARY)) {
    for (const tid of p.sequence) {
      const tpl = p.templates[tid];
      assert.ok(tpl, `${pid}: sequence id ${tid} missing from templates`);
      assert.ok(tpl.exercises.length >= 4, `${pid}/${tid}: only ${tpl.exercises.length} exercises`);
      const ids = tpl.exercises.map((e) => e.id);
      assert.equal(new Set(ids).size, ids.length, `${pid}/${tid}: duplicate exercise ids`);
      for (const e of tpl.exercises) {
        assert.ok(e.id && e.name && e.sets >= 1, `${pid}/${tid}: malformed exercise ${JSON.stringify(e)}`);
      }
    }
  }
});
t("ul5 shares ul4's template objects for the overlapping days (identity, not copy)", () => {
  assert.equal(LIBRARY["ul5-gym"].templates.lowerA, LIBRARY["ul4-gym"].templates.lowerA);
});

console.log("\ngetTemplate — the crash-site fix");
t("own program resolves", () => {
  assert.equal(getTemplate("ul4-gym", "lowerA").name, "Lower A");
});
t("foreign template id (history from another program) resolves via library scan", () => {
  assert.equal(getTemplate("fb3-bw", "lowerA").name, "Lower A");
});
t("unknown id degrades to a stub, never throws — the exact case that used to crash", () => {
  const tpl = getTemplate("ul4-gym", "legacy_bro_split_day");
  assert.equal(tpl.unknown, true);
  assert.equal(tpl.exercises.length, 0);
  assert.match(tpl.name, /Legacy Bro Split Day/);
});
t("unknown PROGRAM id falls back to the default program", () => {
  assert.equal(getTemplate("deleted-program", "lowerA").name, "Lower A");
});
t("emphasis swaps slots without mutating the base template", () => {
  const base = getTemplate("ul4-gym", "lowerA");
  const glutes = getTemplate("ul4-gym", "lowerA", "lower_glutes");
  assert.ok(glutes.exercises.some((e) => e.id === "hip_thrust_heavy"));
  assert.ok(!base.exercises.some((e) => e.id === "hip_thrust_heavy"), "base must stay untouched");
  assert.equal(base.exercises.length, glutes.exercises.length);
});

console.log("\nrotation across program switches");
t("normal rotation advances", () => {
  const w = [{ date: "2026-08-01", template: "lowerA" }];
  assert.equal(nextTemplateFor(w, sequenceFor("ul4-gym")), "upperA");
});
t("wraps at the end", () => {
  const w = [{ date: "2026-08-01", template: "upperB" }];
  assert.equal(nextTemplateFor(w, sequenceFor("ul4-gym")), "lowerA");
});
t("last workout from a FOREIGN program starts the new sequence at day one", () => {
  const w = [{ date: "2026-08-01", template: "lowerA" }]; // ul4 history
  assert.equal(nextTemplateFor(w, sequenceFor("fb3-db")), "fbdA");
});
t("empty history starts at day one", () => {
  assert.equal(nextTemplateFor([], sequenceFor("ul5-gym")), "lowerA");
});

console.log("\nselection matrix");
t("every equipment × days combination yields a real library entry", () => {
  for (const equipment of ["gym", "dumbbells", "bodyweight"]) {
    for (const daysPerWeek of [2, 3, 4, 5, 6]) {
      const id = selectProgram({ daysPerWeek, equipment });
      assert.ok(LIBRARY[id], `${equipment}/${daysPerWeek} → ${id} not in library`);
    }
  }
});
t("gym days map 3→fb3, 4→ul4, 5→ul5; equipment dominates", () => {
  assert.equal(selectProgram({ daysPerWeek: 3, equipment: "gym" }), "fb3-gym");
  assert.equal(selectProgram({ daysPerWeek: 4, equipment: "gym" }), "ul4-gym");
  assert.equal(selectProgram({ daysPerWeek: 6, equipment: "gym" }), "ul5-gym");
  assert.equal(selectProgram({ daysPerWeek: 5, equipment: "dumbbells" }), "fb3-db");
});

console.log("\nphase-aware finishers");
t("cut extends Zone 2, bulk minimizes, maintain passes through", () => {
  const tpl = getTemplate("ul4-gym", "lowerA");
  assert.match(finisherFor(tpl, "cut"), /extend/);
  assert.match(finisherFor(tpl, "bulk"), /Optional/);
  assert.equal(finisherFor(tpl, "maintain"), tpl.finisher);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
