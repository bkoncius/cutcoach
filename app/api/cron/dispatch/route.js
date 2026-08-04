import { requireCron } from "../../../../lib/serverAuth";
import { getSupabaseAdmin } from "../../../../lib/supabaseAdmin";
import { sendToUser } from "../../../../lib/push";
import { nextTemplateFor } from "../../../../lib/program";
import { REMINDERS, REMINDER_BY_ID, localParts, isDue } from "../../../../lib/reminders";
import { computeTrend } from "../../../../lib/trend";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The scheduler endpoint. Scheduler-agnostic on purpose: Vercel Cron sends
 * `Authorization: Bearer $CRON_SECRET` automatically and the pg_cron job in
 * supabase/003_cron.sql sends a byte-identical header, so swapping between them
 * needs no code change here.
 *
 * Debug query params, gated on ALLOW_CRON_DEBUG=1:
 *   ?dry=1                        plan the sends, send nothing
 *   ?now=2026-07-16T07:30:00Z     pretend it's this instant
 */
export async function GET(req) {
  const { error } = requireCron(req);
  if (error) return error;
  try {
    return await dispatch(req);
  } catch (e) {
    // Every failure must come back as a readable body. pg_net is fire-and-forget and
    // reports nothing to pg_cron, so net._http_response.content — i.e. this string — is
    // the only place a misconfiguration will ever show up.
    console.error("dispatch failed", e);
    return Response.json({ ok: false, error: e?.message || "dispatch failed" }, { status: 500 });
  }
}

async function dispatch(req) {
  const url = new URL(req.url);
  // Explicit opt-in env var, NOT NODE_ENV: `next start` runs as production, and that's
  // the only local mode where the SW and push work at all. Gating on NODE_ENV would
  // silently ignore ?dry=1 exactly where you'd type it and send for real instead.
  // Set ALLOW_CRON_DEBUG=1 in .env.local; leave it unset on Vercel.
  const debugAllowed = process.env.ALLOW_CRON_DEBUG === "1";
  const dry = url.searchParams.get("dry") === "1" && debugAllowed;
  // A `now` on a different date sidesteps the dedupe key (which is keyed on local_date)
  // and would let a real send replay — hence the same gate.
  const nowParam = debugAllowed ? url.searchParams.get("now") : null;
  const now = nowParam ? new Date(nowParam) : new Date();
  if (Number.isNaN(now.getTime())) {
    return Response.json({ error: "invalid ?now" }, { status: 400 });
  }

  const admin = getSupabaseAdmin();

  // 1) Only users who could actually receive something. Null targets (an account
  //    that never finished onboarding) are excluded here rather than defaulted later —
  //    a wrong number in a push notification is worse than silence. A pre-wizard row
  //    with real targets still gets its reminders.
  const { data: profiles, error: pErr } = await admin
    .from("profiles")
    .select("user_id, timezone, reminders, phase, kcal_target, protein_target, last_checkin, units, sex, bodyfat_pct, experience")
    .not("timezone", "is", null)
    .not("kcal_target", "is", null)
    .not("protein_target", "is", null);
  if (pErr) return Response.json({ error: pErr.message }, { status: 500 });

  const { data: subRows, error: sErr } = await admin.from("push_subscriptions").select("user_id");
  if (sErr) return Response.json({ error: sErr.message }, { status: 500 });
  const hasDevice = new Set((subRows || []).map((r) => r.user_id));

  // 2) Whose reminder window is open right now?
  const due = [];
  for (const p of profiles || []) {
    if (!hasDevice.has(p.user_id)) continue;
    const prefs = p.reminders || {};
    const parts = localParts(now, p.timezone);
    if (!parts) continue; // unknown IANA zone

    for (const r of REMINDERS) {
      const cfg = prefs[r.id];
      // Explicit opt-in only — never fall back to DEFAULT_REMINDERS here. Someone who
      // never opened the settings card must receive nothing.
      if (!cfg || cfg.enabled !== true) continue;
      if (!isDue(parts.minutes, cfg.time)) continue;
      due.push({ profile: p, reminder: r, cfg, local: parts });
    }
  }

  // 3) 5-minute ticks mean ~288 invocations a day and only a handful do real work.
  //    Bail before touching meals/logs/workouts.
  if (due.length === 0) {
    return Response.json({ ok: true, checked: (profiles || []).length, due: 0, sent: 0 });
  }

  // 4) Bulk-fetch conditions for just the due users — not N queries per user.
  //    Each user has exactly one local date, so this is one context per user.
  const dateByUser = {};
  const profileByUser = {};
  for (const d of due) {
    dateByUser[d.profile.user_id] = d.local.date;
    profileByUser[d.profile.user_id] = d.profile;
  }
  const ctxByUser = await buildContexts(admin, dateByUser, profileByUser);

  // 5+6+7) Evaluate, claim, send.
  const planned = [];
  for (const d of due) {
    const { profile, reminder, cfg, local } = d;
    const ctx = { ...ctxByUser[profile.user_id], localDate: local.date };
    const payload = reminder.build(ctx, cfg);

    if (!payload) {
      planned.push({ user: short(profile.user_id), id: reminder.id, skipped: "condition met" });
      continue;
    }
    if (dry) {
      planned.push({ user: short(profile.user_id), id: reminder.id, localTime: hhmm(local.minutes), would: payload });
      continue;
    }

    // Claim before sending. The unique index on (user_id, reminder_id, local_date) makes
    // this race-safe without a lock, so overlapping or duplicated cron runs are harmless.
    const { data: claim, error: cErr } = await admin
      .from("notification_log")
      .insert({ user_id: profile.user_id, reminder_id: reminder.id, local_date: local.date })
      .select("id");
    if (cErr) {
      if (cErr.code === "23505") {
        planned.push({ user: short(profile.user_id), id: reminder.id, skipped: "deduped" });
        continue;
      }
      planned.push({ user: short(profile.user_id), id: reminder.id, error: cErr.message });
      continue;
    }
    if (!claim || claim.length === 0) {
      planned.push({ user: short(profile.user_id), id: reminder.id, skipped: "deduped" });
      continue;
    }

    // Remaining useful life of the nudge, capped at an hour. web-push's own default is
    // four weeks — a weigh-in reminder surfacing three days late is worse than silence.
    const ttl = Math.max(300, Math.min(3600, (24 * 60 - local.minutes) * 60));
    try {
      const results = await sendToUser(profile.user_id, { ...payload, tag: `cutcoach-${reminder.id}` }, ttl);
      const anyOk = results.some((r) => r.ok);
      // A transient failure (not 403, not a pruned 404/410) should get another shot on
      // the next tick — the 30-min grace window is what makes that possible. Release the
      // claim so it can. 403 is a VAPID mismatch and never recovers; retrying it would
      // just re-send on every tick for 30 minutes.
      // An empty result means the last device vanished between the hasDevice check and
      // the send; that's transient too, and without the length check it would read as
      // "nothing retryable" and burn the slot for the whole day having sent nothing.
      const retryable =
        !anyOk && (results.length === 0 || results.some((r) => r.status !== 403 && !r.pruned));
      if (retryable) {
        await admin.from("notification_log").delete().eq("id", claim[0].id);
      }
      planned.push({ user: short(profile.user_id), id: reminder.id, sent: anyOk, retryable, results });
    } catch (e) {
      await admin.from("notification_log").delete().eq("id", claim[0].id);
      planned.push({ user: short(profile.user_id), id: reminder.id, error: e?.message || "send failed" });
    }
  }

  return Response.json({
    ok: true,
    dry,
    at: now.toISOString(),
    checked: (profiles || []).length,
    due: due.length,
    sent: planned.filter((p) => p.sent).length,
    planned,
  });
}

const short = (id) => `${String(id).slice(0, 8)}…`;
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/**
 * One bulk read per table for every due user, grouped in JS. Profile rows come from
 * the caller (already fetched with everything contextFor needs) — re-querying them
 * here was both redundant and, once identity columns landed, silently incomplete.
 * dateByUser: { [userId]: localDate }, profileByUser: { [userId]: profileRow }
 * -> { [userId]: ctx }
 */
async function buildContexts(admin, dateByUser, profileByUser) {
  const userIds = Object.keys(dateByUser);
  const dates = [...new Set(Object.values(dateByUser))];
  const minDate = dates.slice().sort()[0];
  // 21 days back gives the 14-day trend window slack for missed days.
  const from = shiftDate(minDate, -21);

  const [logsRes, mealsRes, workoutsRes] = await Promise.all([
    admin.from("daily_logs").select("user_id, date, weight").in("user_id", userIds).gte("date", from),
    admin.from("meals").select("user_id, date, kcal, protein").in("user_id", userIds).in("date", dates),
    admin.from("workouts").select("user_id, date, template, exercises").in("user_id", userIds).gte("date", from),
  ]);

  const byUser = {};
  for (const id of userIds) byUser[id] = { logs: [], meals: [], workouts: [], profile: profileByUser[id] || null };
  for (const r of logsRes.data || []) byUser[r.user_id]?.logs.push(r);
  for (const r of mealsRes.data || []) byUser[r.user_id]?.meals.push(r);
  for (const r of workoutsRes.data || []) byUser[r.user_id]?.workouts.push(r);

  const out = {};
  for (const id of userIds) out[id] = contextFor(byUser[id], dateByUser[id]);
  return out;
}

function contextFor(u, date) {
  const p = u.profile || {};

  // Same module the Trend tab renders from (lib/trend.js) — one implementation, so a
  // notification can never contradict the app. This replaced a hand-copied
  // slice(-7)/slice(-14,-7) duplicate that windowed by entries instead of days.
  const trend = computeTrend(
    u.logs.map((l) => ({ date: l.date, weight: l.weight })),
    date
  );

  const todayLog = u.logs.find((l) => l.date === date);
  const todayMeals = u.meals.filter((m) => m.date === date);
  const sum = (xs, k) => xs.reduce((s, x) => s + (Number(x[k]) || 0), 0);

  const workoutsSorted = u.workouts
    .filter((w) => w.date <= date)
    .sort((a, b) => a.date.localeCompare(b.date));
  const lastWorkout = workoutsSorted[workoutsSorted.length - 1] || null;
  const todayWorkout = u.workouts.find((w) => w.date === date) || null;

  return {
    phase: p.phase || "cut",
    // No fallbacks: rows with null targets never reach this function (filtered at the
    // top-level select). The old `?? 2200 / ?? 175` here could put an invented number
    // in a push notification.
    kcalTarget: p.kcal_target,
    proteinTarget: p.protein_target,
    lastCheckin: p.last_checkin || null,
    units: p.units || "metric",
    laneProfile: { sex: p.sex, bodyfatPct: p.bodyfat_pct != null ? Number(p.bodyfat_pct) : null, experience: p.experience },

    weightToday: todayLog?.weight != null ? Number(todayLog.weight) : null,
    trendWeight: trend.trendWeight,
    weeklyRate: trend.rate,

    kcalToday: sum(todayMeals, "kcal"),
    proteinToday: sum(todayMeals, "protein"),
    mealCount: todayMeals.length,

    trainedToday: !!todayWorkout,
    todayTemplate: todayWorkout?.template || null,
    daysSinceWorkout: lastWorkout ? daysBetween(lastWorkout.date, date) : null,
    nextTemplate: nextTemplateFor(workoutsSorted),
    lastMainLift: heaviestSet(lastWorkout),
  };
}

// "Deadlift 140×5" from the first exercise's heaviest logged set — the lift most
// likely to mean something to the reader.
function heaviestSet(workout) {
  if (!workout || !Array.isArray(workout.exercises)) return null;
  for (const ex of workout.exercises) {
    const sets = (ex.sets || []).filter((s) => s && s.w && s.r);
    if (!sets.length) continue;
    const best = sets.reduce((a, b) => (Number(b.w) > Number(a.w) ? b : a));
    return `${ex.name} ${best.w}×${best.r}`;
  }
  return null;
}

// Date-only maths in UTC so a DST boundary can't turn a 2-day gap into 1.96 days.
function daysBetween(a, b) {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86400000);
}

function shiftDate(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
