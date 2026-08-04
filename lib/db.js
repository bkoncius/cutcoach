import { getSupabase } from "./supabaseClient";

// Loads everything and assembles the shapes the UI uses:
// settings {phase, kcalTarget, proteinTarget, startWeight, targetWeight, lastCheckin,
//           timezone, reminders, displayName, sex, birthdate, heightCm, activityLevel,
//           experience, equipment, daysPerWeek, units, bodyfatPct, phaseStartedAt,
//           onboardedAt}
// days     { "YYYY-MM-DD": { weight, meals: [{id, name, kcal, protein, carbs, fat}] } }
// workouts [ {id, date, template, finisher, exercises} ]
// chat     [ {role, content} ]
export async function loadAll() {
  const supabase = getSupabase();
  const [profileRes, logsRes, mealsRes, workoutsRes, chatRes, proposalRes] = await Promise.all([
    supabase.from("profiles").select("*").maybeSingle(),
    supabase.from("daily_logs").select("date, weight, intake_complete"),
    supabase.from("meals").select("id, date, name, kcal, protein, carbs, fat").order("created_at"),
    supabase.from("workouts").select("id, date, template, finisher, exercises").order("date"),
    supabase
      .from("coach_messages")
      .select("role, content, created_at")
      .order("created_at", { ascending: false })
      .limit(30),
    supabase
      .from("engine_proposals")
      .select("id, week_start, status, proposal, created_at")
      .order("week_start", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const p = profileRes.data;
  const settings = p
    ? {
        phase: p.phase,
        kcalTarget: p.kcal_target,
        proteinTarget: p.protein_target,
        startWeight: p.start_weight != null ? Number(p.start_weight) : null,
        targetWeight: p.target_weight != null ? Number(p.target_weight) : null,
        lastCheckin: p.last_checkin,
        timezone: p.timezone || null,
        reminders: p.reminders || {},
        displayName: p.display_name || null,
        sex: p.sex || null,
        birthdate: p.birthdate || null,
        heightCm: p.height_cm != null ? Number(p.height_cm) : null,
        activityLevel: p.activity_level || null,
        experience: p.experience || null,
        equipment: p.equipment || null,
        daysPerWeek: p.days_per_week != null ? Number(p.days_per_week) : null,
        units: p.units || "metric",
        bodyfatPct: p.bodyfat_pct != null ? Number(p.bodyfat_pct) : null,
        phaseStartedAt: p.phase_started_at || null,
        onboardedAt: p.onboarded_at || null,
      }
    : null; // null => brand-new account, the onboarding wizard runs

  const days = {};
  (logsRes.data || []).forEach((r) => {
    days[r.date] = {
      weight: r.weight != null ? Number(r.weight) : undefined,
      intakeComplete: !!r.intake_complete,
      meals: [],
    };
  });
  (mealsRes.data || []).forEach((m) => {
    if (!days[m.date]) days[m.date] = { meals: [] };
    if (!days[m.date].meals) days[m.date].meals = [];
    days[m.date].meals.push({
      id: m.id,
      name: m.name,
      kcal: m.kcal,
      protein: m.protein,
      carbs: m.carbs,
      fat: m.fat,
    });
  });

  const workouts = (workoutsRes.data || []).map((w) => ({
    id: w.id,
    date: w.date,
    template: w.template,
    finisher: w.finisher,
    exercises: w.exercises || [],
  }));

  const chat = (chatRes.data || [])
    .slice()
    .reverse()
    .map((m) => ({ role: m.role, content: m.content }));

  return { settings, days, workouts, chat, proposal: proposalRes?.data || null };
}

async function uid() {
  const supabase = getSupabase();
  const { data } = await supabase.auth.getUser();
  const id = data?.user?.id;
  if (!id) throw new Error("Not signed in");
  return id;
}

export async function saveProfile(settings) {
  const supabase = getSupabase();
  const user_id = await uid();
  // A writer must never invent numbers. The old `|| 2200 / || 175` fallbacks here are
  // how every account silently became an 87→75 kg cut — targets now come only from
  // onboarding, the settings panel, or an applied engine proposal.
  const kcal = Math.round(Number(settings.kcalTarget));
  const protein = Math.round(Number(settings.proteinTarget));
  const start = Number(settings.startWeight);
  const target = Number(settings.targetWeight);
  if (![kcal, protein, start, target].every(Number.isFinite)) {
    throw new Error("saveProfile: targets must be numbers — refusing to invent them");
  }
  const { error } = await supabase.from("profiles").upsert({
    user_id,
    phase: settings.phase || "cut",
    kcal_target: kcal,
    protein_target: protein,
    start_weight: start,
    target_weight: target,
    last_checkin: settings.lastCheckin || null,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}

// Narrow writer #3: the onboarding wizard's single save. Names identity + targets +
// scheduling seed in one shot, stamps phase_started_at and onboarded_at, and records
// the first target_history row so every target ever active has provenance.
export async function saveOnboarding(p) {
  const supabase = getSupabase();
  const user_id = await uid();
  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  const { error } = await supabase.from("profiles").upsert(
    {
      user_id,
      display_name: p.displayName || null,
      sex: p.sex || "unspecified",
      birthdate: p.birthdate,
      height_cm: p.heightCm,
      activity_level: p.activityLevel,
      experience: p.experience,
      equipment: p.equipment,
      days_per_week: p.daysPerWeek,
      units: p.units || "metric",
      bodyfat_pct: p.bodyfatPct ?? null,
      phase: p.phase,
      kcal_target: Math.round(p.kcalTarget),
      protein_target: Math.round(p.proteinTarget),
      start_weight: p.startWeight,
      target_weight: p.targetWeight,
      timezone: p.timezone || null,
      phase_started_at: today,
      onboarded_at: now,
      updated_at: now,
    },
    { onConflict: "user_id" }
  );
  if (error) throw error;

  await recordTargetChange("onboarding", {
    phase: p.phase,
    kcalTarget: p.kcalTarget,
    proteinTarget: p.proteinTarget,
    prevKcal: p.prevKcal ?? null,
    prevProtein: p.prevProtein ?? null,
    context: p.context || {},
  });
}

// Narrow writer #4: identity edits from the settings card. Never touches targets.
export async function saveIdentity(p) {
  const supabase = getSupabase();
  const user_id = await uid();
  const { error } = await supabase.from("profiles").upsert(
    {
      user_id,
      display_name: p.displayName || null,
      sex: p.sex || "unspecified",
      birthdate: p.birthdate,
      height_cm: p.heightCm,
      activity_level: p.activityLevel,
      experience: p.experience,
      equipment: p.equipment,
      days_per_week: p.daysPerWeek,
      units: p.units || "metric",
      bodyfat_pct: p.bodyfatPct ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );
  if (error) throw error;
}

// Append-only provenance for every target change — what the adjustment engine needs
// to say "this target produced that rate" instead of guessing.
export async function recordTargetChange(source, { phase, kcalTarget, proteinTarget, prevKcal, prevProtein, context }) {
  const supabase = getSupabase();
  const user_id = await uid();
  const { error } = await supabase.from("target_history").insert({
    user_id,
    source,
    phase,
    kcal_target: Math.round(kcalTarget),
    protein_target: Math.round(proteinTarget),
    prev_kcal: prevKcal != null ? Math.round(prevKcal) : null,
    prev_protein: prevProtein != null ? Math.round(prevProtein) : null,
    context: context || {},
  });
  if (error) throw error;
}

// Manual phase/target saves stamp the phase clock; the engine refuses to propose
// during the first 14 days of a phase.
export async function stampPhaseStart() {
  const supabase = getSupabase();
  const user_id = await uid();
  const { error } = await supabase.from("profiles").upsert(
    { user_id, phase_started_at: new Date().toISOString().slice(0, 10), updated_at: new Date().toISOString() },
    { onConflict: "user_id" }
  );
  if (error) throw error;
}

// Second narrow writer for `profiles`, deliberately separate from saveProfile().
// Both compile to `ON CONFLICT DO UPDATE SET <listed columns>`, so each only touches
// what it names and neither can clobber the other. Routing reminders through
// saveProfile() instead would rewrite phase/kcalTarget from whatever the settings
// panel last held in memory, which may be stale.
export async function saveReminders(timezone, reminders) {
  const supabase = getSupabase();
  const user_id = await uid();
  const { error } = await supabase.from("profiles").upsert(
    {
      user_id,
      timezone: timezone || null,
      reminders: reminders || {},
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );
  if (error) throw error;
}

export async function upsertWeight(date, weight) {
  const supabase = getSupabase();
  const user_id = await uid();
  const { error } = await supabase
    .from("daily_logs")
    .upsert({ user_id, date, weight }, { onConflict: "user_id,date" });
  if (error) throw error;
}

// The engine's data-quality bit: "everything I ate this day is logged." Explicitly
// user-set — a heuristic would misread both fasts and grazers, and the adaptive TDEE
// stands entirely on this flag being honest.
export async function markDayComplete(date, complete) {
  const supabase = getSupabase();
  const user_id = await uid();
  const { error } = await supabase
    .from("daily_logs")
    .upsert({ user_id, date, intake_complete: !!complete }, { onConflict: "user_id,date" });
  if (error) throw error;
}

// Apply a pending engine proposal: targets + provenance + row status, in that order.
// The status update is guarded on status='pending' so a second tab applying the same
// proposal no-ops instead of double-recording.
export async function applyProposal(row, settings) {
  const supabase = getSupabase();
  const user_id = await uid();
  const p = row.proposal || {};
  const newKcal = p.newKcal ?? settings.kcalTarget;
  const newProtein = p.newProtein ?? settings.proteinTarget;

  const { data: claimed, error: updErr } = await supabase
    .from("engine_proposals")
    .update({ status: "applied", acted_at: new Date().toISOString() })
    .eq("id", row.id)
    .eq("status", "pending")
    .select("id");
  if (updErr) throw updErr;
  if (!claimed || claimed.length === 0) return { alreadyActed: true };

  const { error: tErr } = await supabase.from("profiles").upsert(
    {
      user_id,
      kcal_target: Math.round(newKcal),
      protein_target: Math.round(newProtein),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );
  if (tErr) throw tErr;

  await recordTargetChange("engine", {
    phase: settings.phase,
    kcalTarget: newKcal,
    proteinTarget: newProtein,
    prevKcal: settings.kcalTarget,
    prevProtein: settings.proteinTarget,
    context: { ...(p.basis || {}), proposalId: row.id },
  });
  return { alreadyActed: false, newKcal, newProtein };
}

export async function dismissProposal(rowId) {
  const supabase = getSupabase();
  const { error } = await supabase
    .from("engine_proposals")
    .update({ status: "dismissed", acted_at: new Date().toISOString() })
    .eq("id", rowId)
    .eq("status", "pending");
  if (error) throw error;
}

export async function addMeal(date, meal) {
  const supabase = getSupabase();
  const user_id = await uid();
  const { data, error } = await supabase
    .from("meals")
    .insert({
      user_id,
      date,
      name: meal.name,
      kcal: meal.kcal,
      protein: meal.protein,
      carbs: meal.carbs,
      fat: meal.fat,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

export async function deleteMeal(id) {
  const supabase = getSupabase();
  const { error } = await supabase.from("meals").delete().eq("id", id);
  if (error) throw error;
}

export async function addWorkout(w) {
  const supabase = getSupabase();
  const user_id = await uid();
  const { data, error } = await supabase
    .from("workouts")
    .insert({
      user_id,
      date: w.date,
      template: w.template,
      finisher: !!w.finisher,
      exercises: w.exercises,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

export async function addChatMessage(role, content) {
  const supabase = getSupabase();
  const user_id = await uid();
  const { error } = await supabase.from("coach_messages").insert({ user_id, role, content });
  if (error) throw error;
}
