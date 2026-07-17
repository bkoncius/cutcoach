import { requireCron } from "../../../../lib/serverAuth";
import { getSupabaseAdmin } from "../../../../lib/supabaseAdmin";
import { sendToUser } from "../../../../lib/push";
import { nextTemplateFor } from "../../../../lib/program";
import { REMINDERS, REMINDER_BY_ID, localParts, isDue } from "../../../../lib/reminders";

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

  // 1) Only users who could actually receive something.
  const { data: profiles, error: pErr } = await admin
    .from("profiles")
    .select("user_id, timezone, reminders, phase, kcal_target, protein_target, last_checkin")
    .not("timezone", "is", null);
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
  for (const d of due) dateByUser[d.profile.user_id] = d.local.date;
  const ctxByUser = await buildContexts(admin, dateByUser);

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
 * One bulk read per table for every due user, grouped in JS.
 * dateByUser: { [userId]: localDate }  ->  { [userId]: ctx }
 */
async function buildContexts(admin, dateByUser) {
  const userIds = Object.keys(dateByUser);
  const dates = [...new Set(Object.values(dateByUser))];
  const minDate = dates.slice().sort()[0];
  // 21 days back covers the 7-day average plus the previous 7 for the weekly rate,
  // with slack for missed days.
  const from = shiftDate(minDate, -21);

  const [logsRes, mealsRes, workoutsRes, profilesRes] = await Promise.all([
    admin.from("daily_logs").select("user_id, date, weight").in("user_id", userIds).gte("date", from),
    admin.from("meals").select("user_id, date, kcal, protein").in("user_id", userIds).in("date", dates),
    admin.from("workouts").select("user_id, date, template, exercises").in("user_id", userIds).gte("date", from),
    admin
      .from("profiles")
      .select("user_id, phase, kcal_target, protein_target, last_checkin")
      .in("user_id", userIds),
  ]);

  const byUser = {};
  for (const id of userIds) byUser[id] = { logs: [], meals: [], workouts: [], profile: null };
  for (const r of logsRes.data || []) byUser[r.user_id]?.logs.push(r);
  for (const r of mealsRes.data || []) byUser[r.user_id]?.meals.push(r);
  for (const r of workoutsRes.data || []) byUser[r.user_id]?.workouts.push(r);
  for (const r of profilesRes.data || []) if (byUser[r.user_id]) byUser[r.user_id].profile = r;

  const out = {};
  for (const id of userIds) out[id] = contextFor(byUser[id], dateByUser[id]);
  return out;
}

function contextFor(u, date) {
  const p = u.profile || {};

  // Mirrors the client's chartData/weeklyRate maths (CutCoachApp.jsx) — same window,
  // same >=3-samples guard — so a notification never contradicts the Trend tab.
  const series = u.logs
    .filter((l) => l.weight != null && l.date <= date)
    .map((l) => ({ date: l.date, weight: Number(l.weight) }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const last7 = series.slice(-7);
  const prev7 = series.slice(-14, -7);
  const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x.weight, 0) / xs.length : null);
  const avg7 = avg(last7);
  const weeklyRate =
    last7.length >= 3 && prev7.length >= 3 ? avg(last7) - avg(prev7) : null;

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
    kcalTarget: p.kcal_target ?? 2200,
    proteinTarget: p.protein_target ?? 175,
    lastCheckin: p.last_checkin || null,

    weightToday: todayLog?.weight != null ? Number(todayLog.weight) : null,
    avg7,
    weeklyRate,

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
