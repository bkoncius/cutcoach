// The reminder catalog — imported by BOTH the settings UI and the cron dispatcher so
// the two can't drift. Keep this module pure: no Supabase, no server-only imports, no
// Tailwind class strings (tailwind.config.js doesn't scan lib/).
//
// Each reminder owns its own skip condition and its copy in one build() function,
// because the copy interpolates exactly the numbers the condition inspects.

import { getTemplate } from "./programs.js";
import { laneVerdict } from "./lanes.js";
import { formatWeight, weightUnit } from "./units.js";

// Deliberately a code constant, not UI config: moving the reminder's time should
// implicitly move the expectation of how much protein you'd have logged by then.
export const PROTEIN_PACE = 0.5;

// Fire anywhere in the 30 min after the set time rather than on an exact tick. Vercel
// documents cron runs as best-effort in both directions (missed AND duplicated), and
// pg_net has its own hiccups — a wide window survives a skipped tick. Costs nothing,
// because the notification_log unique index does the "only once" work.
export const GRACE_MINUTES = 30;

export const REMINDERS = [
  {
    id: "weigh_in",
    label: "Morning weigh-in",
    hint: "Skipped if you've already logged a weight today.",
    defaults: { enabled: true, time: "07:30" },
    build: weighInCopy,
  },
  {
    id: "protein",
    label: "Protein pace",
    hint: "Skipped once you're past half your protein target.",
    defaults: { enabled: false, time: "15:00" },
    build: proteinCopy,
  },
  {
    id: "train",
    label: "Training gap",
    hint: "Only fires after 2+ days without a session — not on a fixed weekday.",
    defaults: { enabled: false, time: "17:30", gapDays: 2 },
    build: trainCopy,
  },
  {
    id: "checkin",
    label: "Evening check-in",
    hint: "Skipped if you've already checked in with the coach today.",
    defaults: { enabled: true, time: "20:30" },
    build: checkinCopy,
  },
  {
    id: "weekly_review",
    label: "Weekly plan review",
    hint: "Monday mornings, only when the engine actually proposes a change.",
    defaults: { enabled: true, time: "08:00" },
    build: weeklyReviewCopy,
  },
];

export const REMINDER_BY_ID = Object.fromEntries(REMINDERS.map((r) => [r.id, r]));

// A *proposal* for the settings UI only. The dispatcher never falls back to this —
// it requires an explicit enabled:true, so a user who never opens settings receives
// nothing even with a live subscription. That's the correct direction to fail.
export const DEFAULT_REMINDERS = Object.fromEntries(
  REMINDERS.map((r) => [r.id, { ...r.defaults }])
);

/* ---------------- time ---------------- */


// "07:30" -> 450, or null if malformed
export function parseHM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * A user's wall-clock date and minute-of-day in their own timezone.
 * -> { date: "YYYY-MM-DD", minutes: 0..1439 } | null for an invalid zone.
 *
 * en-CA yields an ISO-shaped date, which is what reproduces the client's todayKey()
 * exactly — the whole condition layer depends on both sides agreeing on "today".
 */
export function localParts(now, timeZone) {
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        // hourCycle:'h23', NOT hour12:false. With hour12:false some ICU builds return
        // "24" for midnight, giving 1440 minutes — a value nothing ever matches, on a
        // date that's off by one. It breaks only at midnight, and only sometimes.
        hourCycle: "h23",
      })
        .formatToParts(now)
        .map((p) => [p.type, p.value])
    );
    if (!parts.year || !parts.hour) return null;
    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      minutes: Number(parts.hour) * 60 + Number(parts.minute),
    };
  } catch {
    return null; // unknown IANA zone
  }
}

export function isDue(localMinutes, timeStr) {
  const at = parseHM(timeStr);
  if (at == null) return false;
  const delta = localMinutes - at;
  return delta >= 0 && delta < GRACE_MINUTES;
}

/* ---------------- shared verdict ---------------- */

// Thin wrapper over lib/lanes.js — the ONE lane implementation shared by the Today
// badge, this notification copy, and (later) the adjustment engine. The old inline
// version accepted ANY negative rate on a cut and any positive on a bulk, silently
// contradicting the lanes the coach prompt described.
export function onTrack(phase, rate, weightKg, profile = {}) {
  const v = laneVerdict(phase, rate, weightKg, profile);
  return v === "in_lane" || v === "unknown";
}

/* ---------------- copy builders ----------------
 * Each takes (ctx, cfg) and returns { title, body, tab } or null to skip.
 *
 * ctx: {
 *   localDate, phase, kcalTarget, proteinTarget, lastCheckin,
 *   weightToday, trendWeight, weeklyRate, units, laneProfile,
 *   kcalToday, proteinToday, mealCount,
 *   trainedToday, todayTemplate, daysSinceWorkout, nextTemplate, lastMainLift,
 * }
 */

function weighInCopy(ctx) {
  if (ctx.weightToday != null) return null; // already logged

  if (ctx.trendWeight == null || ctx.weeklyRate == null) {
    return {
      title: "Weigh in",
      body: "Step on the scale before breakfast — first number of the day.",
      tab: "today",
    };
  }
  const units = ctx.units || "metric";
  const unit = weightUnit(units);
  const sign = ctx.weeklyRate > 0 ? "+" : "−";
  const rate = `${sign}${formatWeight(Math.abs(ctx.weeklyRate), units)} ${unit}/wk`;
  const verdict = onTrack(ctx.phase, ctx.weeklyRate, ctx.trendWeight, ctx.laneProfile || {})
    ? "Right in the lane."
    : "Off the lane.";
  return {
    title: "Weigh in",
    body: `Trend ${formatWeight(ctx.trendWeight, units)} ${unit} · ${rate}. ${verdict} Scale, then coffee.`,
    tab: "today",
  };
}

function proteinCopy(ctx) {
  const target = Number(ctx.proteinTarget) || 0;
  if (target <= 0) return null; // no target to be behind on
  if (ctx.proteinToday >= target * PROTEIN_PACE) return null; // pace is fine

  if (!ctx.mealCount) {
    return {
      title: "Nothing logged yet",
      body: `${ctx.kcalTarget} kcal and ${target} g protein aren't going to log themselves.`,
      tab: "food",
    };
  }
  const left = Math.max(0, target - ctx.proteinToday);
  const portions = Math.max(1, Math.round(left / 30)); // ~30 g per palm-sized portion
  return {
    title: `${ctx.proteinToday} / ${target} g protein`,
    body: `${left} g to go. Roughly ${portions} palm-sized portion${portions === 1 ? "" : "s"} before bed.`,
    tab: "food",
  };
}

function trainCopy(ctx, cfg) {
  if (ctx.trainedToday) return null;

  const gap = Number(cfg?.gapDays) || 2;
  const next = ctx.nextTemplate ? getTemplate(ctx.programId, ctx.nextTemplate) : null;
  const nextName = next && !next.unknown ? next.name : "Your next session";

  if (ctx.daysSinceWorkout == null) {
    return {
      title: "No sessions logged yet",
      body: `${nextName} is where the program starts. 40 minutes and it's done.`,
      tab: "train",
    };
  }
  // Gap mode: targets drift, not a missed weekday. A Mon/Tue/Thu/Fri pattern never
  // has a 2-day gap, so at the default this only fires when something has actually slipped.
  if (ctx.daysSinceWorkout < gap) return null;

  const lift = ctx.lastMainLift ? ` — last ${ctx.lastMainLift}` : "";
  return {
    title: `${ctx.daysSinceWorkout} days since you trained`,
    body: `${nextName} is up${lift}. 40 minutes and it's done.`,
    tab: "train",
  };
}

// Fires only while a pending proposal from the engine exists — the courtesy knock
// for the card already waiting in the app. Dedupe rides notification_log like every
// other reminder, so it fires at most once per local day.
function weeklyReviewCopy(ctx) {
  const p = ctx.pendingProposal;
  if (!p) return null;
  if (p.step === 0 && p.newProtein != null) {
    return {
      title: "Weekly review ready",
      body: `Calories hold; protein moves to ${p.newProtein} g for your current weight. Open to apply.`,
      tab: "today",
    };
  }
  return {
    title: "Weekly review ready",
    body: `Proposed ${p.newKcal} kcal/day (${p.step > 0 ? "+" : ""}${p.step}). Open to see why and apply.`,
    tab: "today",
  };
}

function checkinCopy(ctx) {
  if (ctx.lastCheckin === ctx.localDate) return null; // already checked in

  const trained = ctx.trainedToday && ctx.todayTemplate
    ? ` · trained ${getTemplate(ctx.programId, ctx.todayTemplate).name}`
    : "";
  return {
    title: "Check-in time",
    body: `${ctx.kcalToday}/${ctx.kcalTarget} kcal · ${ctx.proteinToday}/${ctx.proteinTarget} g protein${trained}. Ask the coach how it looks.`,
    tab: "coach",
  };
}
