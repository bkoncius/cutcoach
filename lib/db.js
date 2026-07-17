import { getSupabase } from "./supabaseClient";

// Loads everything and assembles the shapes the UI uses:
// settings {phase, kcalTarget, proteinTarget, startWeight, targetWeight, lastCheckin,
//           timezone, reminders}
// days     { "YYYY-MM-DD": { weight, meals: [{id, name, kcal, protein, carbs, fat}] } }
// workouts [ {id, date, template, finisher, exercises} ]
// chat     [ {role, content} ]
export async function loadAll() {
  const supabase = getSupabase();
  const [profileRes, logsRes, mealsRes, workoutsRes, chatRes] = await Promise.all([
    supabase.from("profiles").select("*").maybeSingle(),
    supabase.from("daily_logs").select("date, weight"),
    supabase.from("meals").select("id, date, name, kcal, protein, carbs, fat").order("created_at"),
    supabase.from("workouts").select("id, date, template, finisher, exercises").order("date"),
    supabase
      .from("coach_messages")
      .select("role, content, created_at")
      .order("created_at", { ascending: false })
      .limit(30),
  ]);

  const p = profileRes.data;
  const settings = p
    ? {
        phase: p.phase,
        kcalTarget: p.kcal_target,
        proteinTarget: p.protein_target,
        startWeight: Number(p.start_weight),
        targetWeight: Number(p.target_weight),
        lastCheckin: p.last_checkin,
        timezone: p.timezone || null,
        reminders: p.reminders || {},
      }
    : null; // null => first run, caller creates defaults

  const days = {};
  (logsRes.data || []).forEach((r) => {
    days[r.date] = { weight: r.weight != null ? Number(r.weight) : undefined, meals: [] };
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

  return { settings, days, workouts, chat };
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
  const { error } = await supabase.from("profiles").upsert({
    user_id,
    phase: settings.phase || "cut",
    kcal_target: Math.round(Number(settings.kcalTarget) || 2200),
    protein_target: Math.round(Number(settings.proteinTarget) || 175),
    start_weight: Number(settings.startWeight) || 0,
    target_weight: Number(settings.targetWeight) || 0,
    last_checkin: settings.lastCheckin || null,
    updated_at: new Date().toISOString(),
  });
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
