// The program library. Pure data + pure functions, isomorphic (client + dispatcher).
//
// Replaces the single hardcoded PROGRAM const. Rules that keep history intact:
// - `ul4-gym` keeps the ORIGINAL template ids (lowerA/upperA/lowerB/upperB) and
//   exercise names, so every existing workout row, prefill match, and rotation
//   position carries over untouched.
// - ul5-gym SHARES those template objects for its four overlapping days — same id,
//   same content — so switching 4↔5 day keeps prefill continuity. A template id may
//   only be shared when the content is identical; anything else gets a fresh id.
// - Every exercise has a stable `id` slug. New workout saves store {id, name, sets};
//   prefill matches id first and falls back to name for legacy rows.
//
// workouts.template stays free text in the DB by design (friendly to future ids) —
// getTemplate() is therefore the ONLY line of defense against unknown ids. Never
// index LIBRARY[...].templates[...] directly outside this module: three exactly-such
// lookups used to crash the Coach and Train tabs the moment history contained a
// template id outside the active program.

const ex = (id, name, sets, reps, rpe) => ({ id, name, sets, reps, rpe });

/* ---------------- shared templates (ul4 + ul5) ---------------- */

const lowerA = {
  name: "Lower A",
  subtitle: "Squat focus",
  finisher: "10 min Zone 2 (incline walk / row)",
  exercises: [
    ex("back_squat", "Back Squat", 4, "5–6", "7–8"),
    ex("rdl", "Romanian Deadlift", 3, "8–10", "8"),
    ex("walking_lunge", "Walking Lunge (DB)", 3, "10/leg", "8"),
    ex("seated_leg_curl", "Seated Leg Curl", 3, "12–15", "9"),
    ex("standing_calf", "Standing Calf Raise", 4, "12–15", "9"),
    ex("hanging_knee_raise", "Hanging Knee Raise", 3, "10–15", "—"),
  ],
};

const upperA = {
  name: "Upper A",
  subtitle: "Bench focus",
  finisher: "Bike intervals 8 × 20s hard / 40s easy",
  exercises: [
    ex("bench_press", "Barbell Bench Press", 4, "5–6", "7–8"),
    ex("lat_pulldown", "Lat Pulldown / Pull-up", 4, "6–8", "8"),
    ex("db_shoulder_press", "Seated DB Shoulder Press", 3, "8–10", "8"),
    ex("chest_supported_row", "Chest-Supported Row", 3, "10–12", "8"),
    ex("lateral_raise", "Lateral Raise", 3, "12–15", "9"),
    ex("ez_curl", "EZ-Bar Curl", 3, "12", "9"),
    ex("rope_pushdown", "Rope Pushdown", 3, "12", "9"),
  ],
};

const lowerB = {
  name: "Lower B",
  subtitle: "Deadlift / posterior",
  finisher: "12–15 min Zone 2",
  exercises: [
    ex("deadlift", "Deadlift", 3, "5", "7–8"),
    ex("leg_press", "Leg Press / Hack Squat", 3, "10–12", "8"),
    ex("hip_thrust", "Hip Thrust", 3, "10–12", "8"),
    ex("leg_extension", "Leg Extension", 3, "15", "9"),
    ex("seated_calf", "Seated Calf Raise", 4, "15", "9"),
    ex("cable_crunch", "Cable Crunch", 3, "12–15", "—"),
  ],
};

const upperB = {
  name: "Upper B",
  subtitle: "Overhead / back",
  finisher: "Intervals or 15 min Zone 2",
  exercises: [
    ex("ohp", "Overhead Press", 4, "6–8", "7–8"),
    ex("incline_db_press", "Incline DB Press", 3, "8–10", "8"),
    ex("seated_cable_row", "Seated Cable Row", 4, "10–12", "8"),
    ex("face_pull", "Face Pull", 3, "15", "9"),
    ex("cable_fly", "Cable Fly / Pec Deck", 3, "12–15", "9"),
    ex("hammer_curl", "Hammer Curl", 3, "12", "9"),
    ex("oh_triceps", "Overhead Triceps Ext", 3, "12", "9"),
  ],
};

/* ---------------- the library ---------------- */

export const LIBRARY = {
  "ul4-gym": {
    name: "Upper/Lower · 4-day",
    daysPerWeek: 4,
    equipment: "gym",
    sequence: ["lowerA", "upperA", "lowerB", "upperB"],
    templates: { lowerA, upperA, lowerB, upperB },
  },

  "ul5-gym": {
    name: "Upper/Lower + Arms · 5-day",
    daysPerWeek: 5,
    equipment: "gym",
    sequence: ["lowerA", "upperA", "lowerB", "upperB", "u5arms"],
    templates: {
      lowerA, upperA, lowerB, upperB, // shared verbatim — see header comment
      u5arms: {
        name: "Arms & Shoulders",
        subtitle: "Pump day",
        finisher: "Optional 10 min Zone 2",
        exercises: [
          ex("ez_curl", "EZ-Bar Curl", 4, "10–12", "9"),
          ex("incline_db_curl", "Incline DB Curl", 3, "12", "9"),
          ex("rope_pushdown", "Rope Pushdown", 4, "10–12", "9"),
          ex("oh_triceps", "Overhead Triceps Ext", 3, "12", "9"),
          ex("lateral_raise", "Lateral Raise", 4, "15", "9"),
          ex("face_pull", "Face Pull", 3, "15", "9"),
        ],
      },
    },
  },

  "fb3-gym": {
    name: "Full Body · 3-day",
    daysPerWeek: 3,
    equipment: "gym",
    sequence: ["fb3A", "fb3B", "fb3C"],
    templates: {
      fb3A: {
        name: "Full Body A",
        subtitle: "Squat + bench",
        finisher: "10 min Zone 2",
        exercises: [
          ex("back_squat", "Back Squat", 3, "5–6", "7–8"),
          ex("bench_press", "Barbell Bench Press", 3, "6–8", "8"),
          ex("chest_supported_row", "Chest-Supported Row", 3, "10–12", "8"),
          ex("seated_leg_curl", "Seated Leg Curl", 3, "12–15", "9"),
          ex("lateral_raise", "Lateral Raise", 3, "12–15", "9"),
          ex("plank", "Plank", 3, "45s", "—"),
        ],
      },
      fb3B: {
        name: "Full Body B",
        subtitle: "Deadlift + press",
        finisher: "Bike intervals 6 × 20s hard / 40s easy",
        exercises: [
          ex("deadlift", "Deadlift", 3, "5", "7–8"),
          ex("ohp", "Overhead Press", 3, "6–8", "8"),
          ex("lat_pulldown", "Lat Pulldown / Pull-up", 3, "8–10", "8"),
          ex("leg_press", "Leg Press", 3, "10–12", "8"),
          ex("ez_curl", "EZ-Bar Curl", 3, "12", "9"),
          ex("cable_crunch", "Cable Crunch", 3, "12–15", "—"),
        ],
      },
      fb3C: {
        name: "Full Body C",
        subtitle: "Volume day",
        finisher: "12 min Zone 2",
        exercises: [
          ex("hack_squat", "Hack Squat / Front Squat", 3, "8–10", "8"),
          ex("incline_db_press", "Incline DB Press", 3, "8–10", "8"),
          ex("seated_cable_row", "Seated Cable Row", 3, "10–12", "8"),
          ex("rdl", "Romanian Deadlift", 3, "8–10", "8"),
          ex("face_pull", "Face Pull", 3, "15", "9"),
          ex("hanging_knee_raise", "Hanging Knee Raise", 3, "10–15", "—"),
        ],
      },
    },
  },

  "fb3-db": {
    name: "Full Body · 3-day · Dumbbells",
    daysPerWeek: 3,
    equipment: "dumbbells",
    sequence: ["fbdA", "fbdB", "fbdC"],
    templates: {
      fbdA: {
        name: "DB Full Body A",
        subtitle: "Squat + push",
        finisher: "10 min brisk walk or stairs",
        exercises: [
          ex("goblet_squat", "Goblet Squat", 3, "10–12", "8"),
          ex("db_bench", "DB Bench / Floor Press", 3, "8–10", "8"),
          ex("one_arm_row", "One-Arm DB Row", 3, "10–12/side", "8"),
          ex("db_rdl", "DB Romanian Deadlift", 3, "10–12", "8"),
          ex("lateral_raise", "Lateral Raise", 3, "12–15", "9"),
          ex("plank", "Plank", 3, "45s", "—"),
        ],
      },
      fbdB: {
        name: "DB Full Body B",
        subtitle: "Single-leg + press",
        finisher: "8 × 20s fast stairs / 40s easy",
        exercises: [
          ex("split_squat", "Bulgarian Split Squat", 3, "8–10/leg", "8"),
          ex("db_shoulder_press", "Seated DB Shoulder Press", 3, "8–10", "8"),
          ex("db_pullover", "DB Pullover", 3, "10–12", "8"),
          ex("db_hip_thrust", "DB Hip Thrust", 3, "10–12", "8"),
          ex("hammer_curl", "Hammer Curl", 3, "12", "9"),
          ex("weighted_situp", "Weighted Sit-up", 3, "10–15", "—"),
        ],
      },
      fbdC: {
        name: "DB Full Body C",
        subtitle: "Lunge + incline",
        finisher: "12 min brisk walk",
        exercises: [
          ex("db_lunge", "DB Walking Lunge", 3, "10/leg", "8"),
          ex("incline_db_press", "Incline DB Press", 3, "8–10", "8"),
          ex("chest_supported_row", "Chest-Supported DB Row", 3, "10–12", "8"),
          ex("single_leg_rdl", "Single-Leg RDL", 3, "10/leg", "8"),
          ex("oh_triceps", "Overhead DB Triceps Ext", 3, "12", "9"),
          ex("lying_leg_raise", "Lying Leg Raise", 3, "10–15", "—"),
        ],
      },
    },
  },

  "fb3-bw": {
    name: "Full Body · 3-day · Bodyweight",
    daysPerWeek: 3,
    equipment: "bodyweight",
    sequence: ["fbwA", "fbwB", "fbwC"],
    templates: {
      fbwA: {
        name: "BW Full Body A",
        subtitle: "Squat + push",
        finisher: "15 min brisk walk",
        exercises: [
          ex("bw_squat", "Squat → Pistol Progression", 3, "8–12", "8"),
          ex("pushup", "Push-up", 3, "8–15", "8"),
          ex("inverted_row", "Inverted Row (table/rings)", 3, "8–12", "8"),
          ex("glute_bridge", "Glute Bridge March", 3, "12/side", "8"),
          ex("plank", "Plank", 3, "45s", "—"),
        ],
      },
      fbwB: {
        name: "BW Full Body B",
        subtitle: "Single-leg + pike",
        finisher: "10 × 30s fast walk / 30s easy",
        exercises: [
          ex("split_squat", "Bulgarian Split Squat", 3, "10–15/leg", "8"),
          ex("pike_pushup", "Pike Push-up", 3, "6–10", "8"),
          ex("doorway_row", "Chin-up / Towel Row", 3, "max reps", "9"),
          ex("sl_hip_thrust", "Single-Leg Hip Thrust", 3, "10–12/leg", "8"),
          ex("hollow_hold", "Hollow Hold", 3, "30s", "—"),
        ],
      },
      fbwC: {
        name: "BW Full Body C",
        subtitle: "Step + decline",
        finisher: "15 min brisk walk",
        exercises: [
          ex("stepup", "Step-up", 3, "12/leg", "8"),
          ex("decline_pushup", "Decline Push-up", 3, "8–12", "8"),
          ex("towel_row", "Towel Row", 3, "10–12", "8"),
          ex("nordic_neg", "Nordic Curl Negative", 3, "4–6", "9"),
          ex("side_plank", "Side Plank", 3, "30s/side", "—"),
        ],
      },
    },
  },
};

export const DEFAULT_PROGRAM_ID = "ul4-gym";

/* ---------------- emphasis variants ----------------
 * Light-touch slot swaps chosen by STATED PREFERENCE at onboarding — never defaulted
 * by sex. { emphasis: { templateId: { exerciseId: replacement } } } */

const EMPHASIS_OVERRIDES = {
  lower_glutes: {
    lowerA: { walking_lunge: ex("hip_thrust_heavy", "Hip Thrust (heavy)", 3, "8–10", "8") },
    lowerB: { leg_extension: ex("abduction", "Hip Abduction", 3, "15–20", "9") },
    fb3A: { lateral_raise: ex("hip_thrust_heavy", "Hip Thrust (heavy)", 3, "8–10", "8") },
    fbdA: { lateral_raise: ex("db_hip_thrust", "DB Hip Thrust", 3, "10–12", "8") },
    fbwA: { plank: ex("sl_hip_thrust", "Single-Leg Hip Thrust", 3, "10–12/leg", "8") },
  },
  upper: {
    lowerA: { hanging_knee_raise: ex("pullup_amrap", "Pull-up (max reps)", 3, "max", "9") },
    lowerB: { cable_crunch: ex("face_pull", "Face Pull", 3, "15", "9") },
    fb3C: { hanging_knee_raise: ex("lateral_raise", "Lateral Raise", 3, "12–15", "9") },
  },
};

/* ---------------- API ---------------- */

export function programFor(programId) {
  return LIBRARY[programId] || LIBRARY[DEFAULT_PROGRAM_ID];
}

export function sequenceFor(programId) {
  return programFor(programId).sequence;
}

const prettify = (id) =>
  String(id || "session")
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * THE resolver — the only sanctioned way to turn a template id into a template.
 * Looks in the user's program, then anywhere in the library (history from an
 * abandoned program still renders properly), then falls back to a harmless stub so
 * an unknown id renders a name instead of throwing mid-tab.
 */
export function getTemplate(programId, templateId, emphasis = null) {
  const own = programFor(programId).templates[templateId];
  let t = own;
  if (!t) {
    for (const p of Object.values(LIBRARY)) {
      if (p.templates[templateId]) {
        t = p.templates[templateId];
        break;
      }
    }
  }
  if (!t) {
    return { name: prettify(templateId), subtitle: "", finisher: null, exercises: [], unknown: true };
  }
  const overrides = emphasis && EMPHASIS_OVERRIDES[emphasis]?.[templateId];
  if (!overrides) return t;
  return {
    ...t,
    exercises: t.exercises.map((e) => overrides[e.id] || e),
  };
}

// The rotation answers WHAT to train next; the training reminder separately answers
// WHEN. An unknown last template (program switch) yields indexOf −1 → (−1+1)%n = 0:
// the new sequence deliberately starts at the top.
export function nextTemplateFor(workouts, sequence) {
  const seq = sequence || LIBRARY[DEFAULT_PROGRAM_ID].sequence;
  if (!workouts || !workouts.length) return seq[0];
  const last = [...workouts].sort((a, b) => a.date.localeCompare(b.date)).pop();
  const idx = seq.indexOf(last.template);
  return seq[(idx + 1) % seq.length];
}

// Onboarding answers → a library entry. Equipment dominates; days refine.
export function selectProgram({ daysPerWeek, equipment }) {
  if (equipment === "bodyweight") return "fb3-bw";
  if (equipment === "dumbbells") return "fb3-db";
  const d = Number(daysPerWeek) || 4;
  if (d <= 3) return "fb3-gym";
  if (d === 4) return "ul4-gym";
  return "ul5-gym";
}

// Phase-aware cardio: a cut leans on Zone 2; a bulk keeps it token.
export function finisherFor(template, phase) {
  if (!template || !template.finisher) return null;
  if (phase === "cut") return `${template.finisher} — extend ~25%, the deficit's best friend`;
  if (phase === "bulk") return "Optional: 5–10 min easy walk";
  return template.finisher;
}
