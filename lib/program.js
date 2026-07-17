// Benas's 4-day plan. Lives here rather than in the component because the push
// dispatcher needs the same template names and rotation — duplicating them would let
// a notification name a different next session than the Train tab does.
// Pure data + pure functions: safe to import from both a client component and a route.

export const PROGRAM = {
  lowerA: {
    name: "Lower A",
    subtitle: "Squat focus",
    finisher: "10 min Zone 2 (incline walk / row)",
    exercises: [
      { name: "Back Squat", sets: 4, reps: "5–6", rpe: "7–8" },
      { name: "Romanian Deadlift", sets: 3, reps: "8–10", rpe: "8" },
      { name: "Walking Lunge (DB)", sets: 3, reps: "10/leg", rpe: "8" },
      { name: "Seated Leg Curl", sets: 3, reps: "12–15", rpe: "9" },
      { name: "Standing Calf Raise", sets: 4, reps: "12–15", rpe: "9" },
      { name: "Hanging Knee Raise", sets: 3, reps: "10–15", rpe: "—" },
    ],
  },
  upperA: {
    name: "Upper A",
    subtitle: "Bench focus",
    finisher: "Bike intervals 8 × 20s hard / 40s easy",
    exercises: [
      { name: "Barbell Bench Press", sets: 4, reps: "5–6", rpe: "7–8" },
      { name: "Lat Pulldown / Pull-up", sets: 4, reps: "6–8", rpe: "8" },
      { name: "Seated DB Shoulder Press", sets: 3, reps: "8–10", rpe: "8" },
      { name: "Chest-Supported Row", sets: 3, reps: "10–12", rpe: "8" },
      { name: "Lateral Raise", sets: 3, reps: "12–15", rpe: "9" },
      { name: "EZ-Bar Curl", sets: 3, reps: "12", rpe: "9" },
      { name: "Rope Pushdown", sets: 3, reps: "12", rpe: "9" },
    ],
  },
  lowerB: {
    name: "Lower B",
    subtitle: "Deadlift / posterior",
    finisher: "12–15 min Zone 2",
    exercises: [
      { name: "Deadlift", sets: 3, reps: "5", rpe: "7–8" },
      { name: "Leg Press / Hack Squat", sets: 3, reps: "10–12", rpe: "8" },
      { name: "Hip Thrust", sets: 3, reps: "10–12", rpe: "8" },
      { name: "Leg Extension", sets: 3, reps: "15", rpe: "9" },
      { name: "Seated Calf Raise", sets: 4, reps: "15", rpe: "9" },
      { name: "Cable Crunch", sets: 3, reps: "12–15", rpe: "—" },
    ],
  },
  upperB: {
    name: "Upper B",
    subtitle: "Overhead / back",
    finisher: "Intervals or 15 min Zone 2",
    exercises: [
      { name: "Overhead Press", sets: 4, reps: "6–8", rpe: "7–8" },
      { name: "Incline DB Press", sets: 3, reps: "8–10", rpe: "8" },
      { name: "Seated Cable Row", sets: 4, reps: "10–12", rpe: "8" },
      { name: "Face Pull", sets: 3, reps: "15", rpe: "9" },
      { name: "Cable Fly / Pec Deck", sets: 3, reps: "12–15", rpe: "9" },
      { name: "Hammer Curl", sets: 3, reps: "12", rpe: "9" },
      { name: "Overhead Triceps Ext", sets: 3, reps: "12", rpe: "9" },
    ],
  },
};

export const SEQUENCE = ["lowerA", "upperA", "lowerB", "upperB"];

// The rotation answers *what* to train next. It deliberately says nothing about *when* —
// that's the reminder's job, and conflating the two is what makes fixed-weekday
// reminders nag on rest days.
export function nextTemplateFor(workouts) {
  if (!workouts || !workouts.length) return "lowerA";
  const last = [...workouts].sort((a, b) => a.date.localeCompare(b.date)).pop();
  const idx = SEQUENCE.indexOf(last.template);
  return SEQUENCE[(idx + 1) % SEQUENCE.length];
}
