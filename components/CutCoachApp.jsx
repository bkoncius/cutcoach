"use client";

import { useState, useEffect, useRef } from "react";
import {
  ResponsiveContainer, ComposedChart, Line, XAxis, YAxis, Tooltip,
  ReferenceLine, CartesianGrid,
} from "recharts";
import {
  Home, Utensils, Dumbbell, TrendingDown, MessageCircle, Plus, Trash2,
  Check, Sparkles, Settings2, ChevronRight, X, Flame, Send, ClipboardCheck, Camera,
} from "lucide-react";
import { askClaude } from "../lib/api";
import {
  loadAll,
  saveProfile,
  upsertWeight,
  addMeal as dbAddMeal,
  deleteMeal as dbDeleteMeal,
  addWorkout as dbAddWorkout,
  addChatMessage,
  recordTargetChange,
  stampPhaseStart,
} from "../lib/db";
import { getSupabase } from "../lib/supabaseClient";
import { read as readLedger, write as writeLedger, clear as clearLedger } from "../lib/ledgerCache";
import { syncPushSubscription, unsubscribePush } from "../lib/pushClient";
import { PROGRAM, SEQUENCE, nextTemplateFor } from "../lib/program";
import { computeTrend, trendSeries } from "../lib/trend";
import { laneVerdict, laneText, laneRules, weeksInLane } from "../lib/lanes";
import { formatWeight, weightUnit, parseWeightInput, validWeightKg, kgToLb } from "../lib/units";
import { ageFrom, suggestTargets, checkGoal } from "../lib/calc";
import NotificationSettings from "./NotificationSettings";
import Onboarding from "./Onboarding";
import ProfileCard from "./ProfileCard";
import { Card, Eyebrow, Bar } from "./ui";

const APP_VERSION = "3.1";

// Shape-only. Targets are DELIBERATELY null — the onboarding wizard is the only
// place they get minted (the old 2200/175/87/75 literals here were silently written
// to the DB for every new sign-up, branding everyone an 87→75 kg male cut). Anything
// that renders targets sits behind the onboardedAt gate, where real values exist.
const DEFAULT_SETTINGS = {
  phase: "cut",
  kcalTarget: null,
  proteinTarget: null,
  startWeight: null,
  targetWeight: null,
  lastCheckin: null,
  timezone: null,
  // Empty, not DEFAULT_REMINDERS: the dispatcher requires an explicit enabled:true,
  // so nothing fires until you've actually opened the reminders card and saved.
  reminders: {},
  displayName: null,
  sex: null,
  birthdate: null,
  heightCm: null,
  activityLevel: null,
  experience: null,
  equipment: null,
  daysPerWeek: null,
  units: "metric",
  bodyfatPct: null,
  phaseStartedAt: null,
  onboardedAt: null,
};

// Lane prose no longer lives here — it's GENERATED from lib/lanes.js with the user's
// actual bodyweight (laneText for display, laneRules for the coach prompt), so the
// text can never contradict the verdict code again. `suggest` presets die in the
// onboarding phase, replaced by lib/calc.js.
const PHASES = {
  cut: { label: "Cut", title: "The Cut", suggest: { kcal: 2200, protein: 175, deltaKg: -12 } },
  maintain: { label: "Maintain", title: "Maintenance", suggest: { kcal: 2750, protein: 160, deltaKg: 0 } },
  bulk: { label: "Bulk", title: "The Bulk", suggest: { kcal: 3050, protein: 170, deltaKg: 5 } },
};

/* ---------------- Helpers ---------------- */

const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const shortDate = (k) => k.slice(5).replace("-", ".");
const fmt1 = (n) => (Math.round(n * 10) / 10).toFixed(1);

const TABS = ["today", "food", "train", "trend", "coach"];

const relTime = (ms) => {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return `${Math.round(hrs / 24)} d ago`;
};

/* ---------------- Main App ---------------- */

export default function CutCoachApp({ userId }) {
  const [tab, setTab] = useState("today");
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState("");
  const [staleAt, setStaleAt] = useState(0);   // >0 => showing a cached ledger, network failed
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [days, setDays] = useState({});       // { "YYYY-MM-DD": { weight, meals:[{id,name,kcal,protein,carbs,fat}] } }
  const [workouts, setWorkouts] = useState([]); // [{ id, date, template, exercises, finisher }]
  const [chat, setChat] = useState([]);        // [{ role, content }]
  const [active, setActive] = useState(null);  // active workout session
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    const apply = (all) => {
      setSettings(all.settings ? { ...DEFAULT_SETTINGS, ...all.settings } : DEFAULT_SETTINGS);
      setDays(all.days || {});
      setWorkouts(all.workouts || []);
      setChat(all.chat || []);
    };

    // Paint the last snapshot immediately; the network pass below overwrites it.
    const cached = readLedger(userId);
    if (cached) {
      apply(cached.data);
      setLoading(false);
    }

    (async () => {
      try {
        const all = await loadAll();
        // No profile row => brand-new account. Nothing is written here — the
        // onboarding wizard (gated below on onboardedAt) is the only target minter.
        apply(all);
        writeLedger(userId, all);
        setLoadErr("");
        setStaleAt(0);
      } catch (e) {
        // Offline with something to show is a different story than a hard failure.
        // Fall back to now, not to a truthy sentinel — a 0 here would render as
        // "showing your ledger from 20900 d ago".
        if (cached) setStaleAt(cached.at || Date.now());
        else setLoadErr(e?.message || "load failed");
      }
      setLoading(false);
    })();
  }, [userId]);

  useEffect(() => {
    // Cold start from a notification tap: /?tab=coach. Read in an effect rather than
    // a useState initializer — client components still render on the server, where
    // window doesn't exist.
    const t = new URLSearchParams(window.location.search).get("tab");
    if (TABS.includes(t)) setTab(t);

    // Warm start: the SW focuses this window and posts instead of navigating.
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (e) => {
      if (e.data && e.data.type === "NAVIGATE_TAB" && TABS.includes(e.data.tab)) setTab(e.data.tab);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    // Reconcile the push subscription on every open. iOS can evict one from an unused
    // home-screen app without firing pushsubscriptionchange, and push then stops with
    // no symptom. Also re-syncs the timezone after travel or a DST shift.
    syncPushSubscription();
  }, [userId]);

  const signOut = async () => {
    // Order matters: unsubscribing needs the JWT that signOut() destroys.
    try {
      await unsubscribePush();
    } catch {
      /* a dead subscription row is pruned on its next 410 */
    }
    try {
      await getSupabase().auth.signOut();
    } finally {
      clearLedger(userId);
    }
  };

  const persistSettings = (next) => {
    setSettings(next);
    saveProfile(next).catch(console.error);
  };

  // The settings cards write to Supabase themselves; these only mirror the saved
  // values into local state. Without them a card — which unmounts every time the
  // settings sheet closes — would re-seed from a stale prop and show old values.
  const rememberReminders = (timezone, reminders) =>
    setSettings((s) => ({ ...s, timezone, reminders }));
  const rememberIdentity = (p) => setSettings((s) => ({ ...s, ...p }));

  const logWeight = (date, weight) => {
    setDays((d) => ({ ...d, [date]: { ...(d[date] || { meals: [] }), weight } }));
    upsertWeight(date, weight).catch(console.error);
  };

  const addMealFn = async (date, meal) => {
    const id = await dbAddMeal(date, meal);
    setDays((d) => ({
      ...d,
      [date]: {
        ...(d[date] || {}),
        meals: [...(((d[date] || {}).meals) || []), { ...meal, id }],
      },
    }));
  };

  const deleteMealFn = (date, id) => {
    setDays((d) => ({
      ...d,
      [date]: {
        ...(d[date] || {}),
        meals: ((((d[date] || {}).meals) || [])).filter((m) => m.id !== id),
      },
    }));
    dbDeleteMeal(id).catch(console.error);
  };

  const saveWorkoutFn = async (session) => {
    const id = await dbAddWorkout(session);
    setWorkouts((w) => [...w, { ...session, id }]);
  };

  const persistChat = (next) => setChat(next);

  /* ---------- derived data ---------- */

  const tk = todayKey();
  const today = days[tk] || { meals: [] };
  const kcalToday = (today.meals || []).reduce((s, m) => s + (Number(m.kcal) || 0), 0);
  const protToday = (today.meals || []).reduce((s, m) => s + (Number(m.protein) || 0), 0);

  // All trend math lives in lib/trend.js — one shared implementation with the cron
  // dispatcher, calendar-windowed so sparse logging can't inflate the rate (the old
  // slice(-7) entry-windowing overstated an every-other-day logger's rate ~2×).
  const weightSeries = Object.entries(days)
    .filter(([, v]) => v && v.weight != null)
    .map(([date, v]) => ({ date, weight: Number(v.weight) }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Chart values are converted to display units HERE, at the edge — every stored and
  // computed number stays metric.
  const toDisplayW = (kg) =>
    settings.units === "imperial" ? Math.round(kgToLb(kg) * 100) / 100 : kg;
  const chartData = trendSeries(weightSeries).map((e) => ({
    label: shortDate(e.date),
    weight: toDisplayW(e.weight),
    avg: toDisplayW(e.trend), // chart line keeps its dataKey; the value is now the EWMA trend
  }));

  const trendState = computeTrend(weightSeries, tk);
  const currentAvg = trendState.trendWeight;
  const weeklyRate = trendState.rate;

  const lastOfTemplate = (t) =>
    [...workouts].filter((w) => w.template === t).sort((a, b) => b.date.localeCompare(a.date))[0];

  const suggestedTemplate = nextTemplateFor(workouts);

  /* ---------- coach context ---------- */

  const buildContext = () => {
    const workoutByDate = {};
    workouts.forEach((w) => { workoutByDate[w.date] = PROGRAM[w.template].name; });

    const lines = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const v = days[k];
      const parts = [];
      if (v && v.weight) parts.push(`${fmt1(v.weight)}kg`);
      if (v && (v.meals || []).length) {
        const ms = v.meals;
        const kc = ms.reduce((s, m) => s + (Number(m.kcal) || 0), 0);
        const pr = ms.reduce((s, m) => s + (Number(m.protein) || 0), 0);
        const cb = ms.reduce((s, m) => s + (Number(m.carbs) || 0), 0);
        const ft = ms.reduce((s, m) => s + (Number(m.fat) || 0), 0);
        parts.push(`${kc}kcal (${pr}P/${cb}C/${ft}F)`);
      }
      if (workoutByDate[k]) parts.push(`trained ${workoutByDate[k]}`);
      if (parts.length) lines.push(`${shortDate(k)}: ${parts.join(", ")}`);
    }

    const todayMeals = (((days[todayKey()] || {}).meals) || [])
      .map((m) => `${m.name} (${m.kcal}kcal ${m.protein}P/${m.carbs || 0}C/${m.fat || 0}F)`)
      .join("; ");

    const recentW = [...workouts].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6).map((w) => {
      const ex = w.exercises
        .map((e) => {
          const sets = (e.sets || []).filter((s) => s.w && s.r);
          return sets.length ? `${e.name} ${sets.map((s) => `${s.w}×${s.r}`).join(",")}` : null;
        })
        .filter(Boolean)
        .join("; ");
      return `${shortDate(w.date)} ${PROGRAM[w.template].name}${w.finisher ? " +cardio" : ""} — ${ex || "logged"}`;
    });

    // Lane rules are GENERATED from lib/lanes.js with the user's actual weight — the
    // same numbers the badge and notifications check, so prompt and UI can't drift.
    const laneProfile = { sex: settings.sex, bodyfatPct: settings.bodyfatPct, experience: settings.experience };
    const rules = laneRules(settings.phase, currentAvg ?? weightSeries[weightSeries.length - 1]?.weight, laneProfile);
    const trendLine =
      currentAvg != null
        ? `Current trend weight ${fmt1(currentAvg)} kg${weeklyRate != null ? `, moving ${weeklyRate > 0 ? "+" : ""}${weeklyRate.toFixed(2)} kg/week` : " (not enough weigh-ins yet for a rate)"}.`
        : "No weigh-ins yet.";

    // Identity from the actual profile — the old hardcoded "Benas... male, 29, 182 cm"
    // string described exactly one person and was served to everyone.
    const name = settings.displayName || "the client";
    const sexWord = settings.sex === "male" ? "male" : settings.sex === "female" ? "female" : "unspecified sex";
    const age = settings.birthdate ? ageFrom(settings.birthdate) : null;
    const identity = `You are the built-in AI coach in CutCoach, a personal training & nutrition app. Client: ${name}, ${sexWord}${age ? `, ${age}` : ""}${settings.heightCm ? `, ${Math.round(settings.heightCm)} cm` : ""}${settings.bodyfatPct ? `, ~${settings.bodyfatPct}% body fat` : ""}. ${settings.experience || "intermediate"} lifter, ${settings.equipment === "gym" ? "full gym" : settings.equipment === "dumbbells" ? "dumbbells only" : settings.equipment === "bodyweight" ? "no equipment" : "full gym"}, ${settings.daysPerWeek || 4} training days/week. Program: 4-day upper/lower split with Zone-2/interval finishers.`;
    const femaleNote =
      settings.sex === "female"
        ? "\nFemale-specific: expect intra-month water-weight fluctuations of 1-2 kg on a roughly monthly rhythm; judge progress across 2-4 week trend windows and never recommend calorie cuts in response to a single-week stall that may coincide with cyclical retention."
        : "";
    const unitsNote =
      settings.units === "imperial"
        ? "\nThe client thinks in pounds — communicate weights in lb (data below is in kg; convert when you mention numbers)."
        : "";

    return `${identity}
Phase start weight ${settings.startWeight} kg, phase goal ${settings.targetWeight} kg.
Daily targets: ${settings.kcalTarget} kcal, ${settings.proteinTarget} g protein.
${trendLine}
${rules}${femaleNote}${unitsNote}
Universal rules: judge weight by the trend weight only, never single days. Flag 2+ missing logging days honestly. Suggest a deload every 5–6 weeks of hard training.
Style: thorough and specific — reference actual numbers from the data. For check-ins cover: weight trajectory vs the phase lane; calorie and protein adherence; macro balance, including carb placement on training vs rest days and fat consistency; lift-by-lift progression; then one concrete priority for today and any target adjustment per the phase rules. 250–400 words for check-ins, shorter for quick questions. Plain text only — no markdown, no asterisks, no headers, no bullet symbols. Short paragraphs.

DATA — last 14 days (weight, intake, training):
${lines.length ? lines.join("\n") : "No daily logs yet."}

TODAY'S MEALS SO FAR:
${todayMeals || "None yet."}

RECENT WORKOUTS (all logged sets):
${recentW.length ? recentW.join("\n") : "None logged yet."}`;
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="text-slate-500 font-mono text-sm animate-pulse">loading your ledger…</div>
      </div>
    );
  }

  // The onboarding gate: no onboardedAt means either a brand-new account or a
  // pre-migration row (wizard shows prefilled from it). Everything below this line
  // may assume real, non-null targets.
  if (!settings.onboardedAt) {
    if (loadErr) {
      return (
        <div className="min-h-screen bg-slate-950 flex items-center justify-center px-8">
          <div className="text-sm text-rose-400 text-center leading-relaxed">
            Couldn't load your profile ({loadErr}). Setup needs a connection — check your network and reload.
          </div>
        </div>
      );
    }
    return (
      <Onboarding
        settings={settings}
        onComplete={(p, tk) => {
          const next = {
            ...settings,
            ...p,
            phaseStartedAt: tk,
            onboardedAt: new Date().toISOString(),
          };
          setSettings(next);
          setDays((d) => ({ ...d, [tk]: { ...(d[tk] || { meals: [] }), weight: p.startWeight } }));
          // Persist the post-onboarding shape so an offline reopen lands in the app,
          // not back in the wizard.
          writeLedger(userId, { settings: next, days: { ...days, [tk]: { ...(days[tk] || { meals: [] }), weight: p.startWeight } }, workouts, chat });
        }}
      />
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100" style={{ fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
      <div
        className="max-w-md mx-auto px-4"
        style={{
          // Grows to match the taller nav below, and clears the notch up top
          // (statusBarStyle black-translucent puts us under the clock).
          paddingTop: "calc(1.5rem + env(safe-area-inset-top))",
          paddingBottom: "calc(7rem + env(safe-area-inset-bottom))",
        }}
      >
        {loadErr && (
          <div className="mb-3 text-xs text-rose-400">
            Couldn't load your data ({loadErr}). Refresh the page or sign in again.
          </div>
        )}
        {!loadErr && staleAt > 0 && (
          <div className="mb-3 text-xs text-slate-500">
            Offline — showing your ledger from {relTime(staleAt)}. Anything you log now won't be saved.
          </div>
        )}
        {tab === "today" && (
          <TodayTab
            settings={settings} persistSettings={persistSettings}
            days={days} logWeight={logWeight}
            kcalToday={kcalToday} protToday={protToday}
            trendState={trendState} weightEntries={weightSeries}
            suggestedTemplate={suggestedTemplate}
            goTrain={() => setTab("train")} goCoach={() => setTab("coach")}
            showSettings={showSettings} setShowSettings={setShowSettings}
            signOut={signOut} saveReminders={rememberReminders} saveIdentityLocal={rememberIdentity}
          />
        )}
        {tab === "food" && (
          <FoodTab days={days} addMeal={addMealFn} deleteMeal={deleteMealFn}
            settings={settings} kcalToday={kcalToday} protToday={protToday} />
        )}
        {tab === "train" && (
          <TrainTab
            active={active} setActive={setActive}
            workouts={workouts} onSaveWorkout={saveWorkoutFn}
            lastOfTemplate={lastOfTemplate} suggestedTemplate={suggestedTemplate}
          />
        )}
        {tab === "trend" && (
          <TrendTab chartData={chartData} settings={settings}
            trendState={trendState} days={days} />
        )}
        {tab === "coach" && (
          <CoachTab chat={chat} persistChat={persistChat}
            buildContext={buildContext}
            settings={settings} persistSettings={persistSettings} />
        )}
      </div>

      {/* Bottom navigation */}
      {/* Inset goes on the fixed element, not the inner row — padding the inner div
          would leave a transparent strip below the bar. No-op in a browser tab. */}
      <div
        className="fixed bottom-0 inset-x-0 border-t border-slate-800 bg-slate-950 bg-opacity-95 backdrop-blur"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="max-w-md mx-auto flex justify-between px-6 py-2">
          {[
            { id: "today", icon: Home, label: "Today" },
            { id: "food", icon: Utensils, label: "Food" },
            { id: "train", icon: Dumbbell, label: "Train" },
            { id: "trend", icon: TrendingDown, label: "Trend" },
            { id: "coach", icon: MessageCircle, label: "Coach" },
          ].map(({ id, icon: Icon, label }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex flex-col items-center gap-1 px-2 py-1 rounded-xl ${
                tab === id ? "text-amber-400" : "text-slate-500"
              }`}
            >
              <Icon size={20} strokeWidth={tab === id ? 2.4 : 1.8} />
              <span className="text-xs">{label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------------- Today ---------------- */

function TodayTab({
  settings, persistSettings, days, logWeight, kcalToday, protToday,
  trendState, weightEntries, suggestedTemplate, goTrain, goCoach,
  showSettings, setShowSettings, signOut, saveReminders, saveIdentityLocal,
}) {
  const tk = todayKey();
  const units = settings.units || "metric";
  const unit = weightUnit(units);
  // Draft is in DISPLAY units; storage is always kg (lib/units.js converts at the edge).
  const todaysWeight = days[tk] && days[tk].weight != null ? formatWeight(days[tk].weight, units) : "";
  const [w, setW] = useState(todaysWeight);
  const [savedFlash, setSavedFlash] = useState(false);

  // Cached-then-network hydration can change today's stored weight after mount. Sync
  // the draft only while the user hasn't typed — never clobber mid-edit.
  const lastSynced = useRef(todaysWeight);
  useEffect(() => {
    if (todaysWeight !== lastSynced.current) {
      if (w === lastSynced.current) setW(todaysWeight);
      lastSynced.current = todaysWeight;
    }
  }, [todaysWeight, w]);

  const saveWeight = () => {
    // The old hardcoded 30–250 check silently accepted a lb-thinking user's "185"
    // and stored 185 kg. Parse in the display unit, validate in kg.
    const kg = parseWeightInput(w, units);
    if (!validWeightKg(kg)) return;
    logWeight(tk, Math.round(kg * 10) / 10);
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1200);
  };

  const currentAvg = trendState.trendWeight;
  const weeklyRate = trendState.rate;
  const lowConf = trendState.confidence === "low";
  const laneProfile = { sex: settings.sex, bodyfatPct: settings.bodyfatPct, experience: settings.experience };
  // Same module the notifications and coach prompt use — they cannot disagree.
  const verdict = laneVerdict(settings.phase, weeklyRate, currentAvg, laneProfile);
  const goodRate = verdict === "in_lane" || verdict === "unknown";

  const isMaintain = (settings.phase || "cut") === "maintain";
  const span = settings.targetWeight - settings.startWeight;
  const change = currentAvg != null ? currentAvg - settings.startWeight : 0;
  const rawPct = span !== 0 ? (change / span) * 100 : 0;
  const wrongDirection = !isMaintain && currentAvg != null && rawPct < -0.5;
  const pct = Math.max(0, Math.min(100, rawPct));

  // Maintenance has no start→goal distance to fill; show position inside the ±1%
  // hold band plus how long the trend has stayed in lane.
  const band = settings.startWeight * 0.01;
  const gaugePct =
    isMaintain && currentAvg != null && band > 0
      ? Math.max(0, Math.min(100, ((currentAvg - (settings.startWeight - band)) / (2 * band)) * 100))
      : 50;
  const inLaneWeeks = isMaintain ? weeksInLane(weightEntries, tk, "maintain", laneProfile) : 0;

  const checkedInToday = settings.lastCheckin === tk;
  const sugg = PROGRAM[suggestedTemplate];

  const dateStr = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <Eyebrow>{(PHASES[settings.phase] || PHASES.cut).title} · Ledger · v{APP_VERSION}</Eyebrow>
          <h1 className="text-xl font-bold tracking-tight mt-1">{dateStr}</h1>
        </div>
        <button onClick={() => setShowSettings(!showSettings)} className="text-slate-500 p-2">
          {showSettings ? <X size={18} /> : <Settings2 size={18} />}
        </button>
      </div>

      {showSettings && (
        <>
          <SettingsPanel settings={settings} persistSettings={persistSettings} currentAvg={currentAvg} signOut={signOut} />
          {/* Sibling cards, deliberately not folded into SettingsPanel: each holds its
              own draft state and its own narrow DB writer, so a save from one can never
              rewrite another's columns from stale in-memory values. */}
          <ProfileCard settings={settings} onSaved={saveIdentityLocal} />
          <NotificationSettings settings={settings} onSaved={saveReminders} />
        </>
      )}

      {/* Hero: the number that matters */}
      <Card className="border-amber-400 border-opacity-30">
        <Eyebrow color="text-amber-400">Trend weight — the number that matters</Eyebrow>
        <div className="flex items-end gap-3 mt-2">
          <div className="font-mono text-5xl font-bold tracking-tight">
            {formatWeight(currentAvg, units)}
          </div>
          <div className="pb-1 text-slate-400 text-sm">{unit}</div>
          {weeklyRate != null && (
            <div className={`ml-auto mb-1 font-mono text-sm px-2 py-1 rounded-lg ${
              goodRate ? "bg-slate-800 text-teal-300" : "bg-slate-800 text-rose-300"
            }`}>
              {lowConf ? "~" : ""}{weeklyRate > 0 ? "+" : ""}{formatWeight(weeklyRate, units)} {unit}/wk
              {verdict === "slow" ? " · slow" : verdict === "fast" ? " · fast" : ""}
            </div>
          )}
        </div>
        {weeklyRate == null && (
          <div className="text-xs text-slate-500 mt-1">
            {trendState.nPoints === 0
              ? "Log your first weigh-in to start the trend."
              : trendState.pointsNeeded > 0
              ? `${trendState.pointsNeeded} more weigh-in${trendState.pointsNeeded === 1 ? "" : "s"} until your trend appears.`
              : "A few more days of weigh-ins until your trend appears."}
          </div>
        )}
        {isMaintain ? (
          /* Maintenance: a start→goal bar is meaningless (start === goal). Show
             position inside the ±1% hold band and how long the trend has held it. */
          <div className="mt-4">
            <div className="flex justify-between text-xs font-mono text-slate-500 mb-1">
              <span>{formatWeight(settings.startWeight - band, units)}</span>
              <span className="text-slate-300">
                {inLaneWeeks > 0 ? `${inLaneWeeks} wk${inLaneWeeks === 1 ? "" : "s"} in lane` : "hold the line"}
              </span>
              <span>{formatWeight(settings.startWeight + band, units)}</span>
            </div>
            <div className="relative h-2 rounded-full bg-slate-800">
              <div className="absolute inset-y-0 left-1/2 w-px bg-slate-600" />
              <div
                className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 h-3 w-3 rounded-full ${
                  goodRate ? "bg-teal-400" : "bg-rose-400"
                }`}
                style={{ left: `${gaugePct}%` }}
              />
            </div>
          </div>
        ) : (
          <div className="mt-4">
            <div className="flex justify-between text-xs font-mono text-slate-500 mb-1">
              <span>{formatWeight(settings.startWeight, units)}</span>
              <span className={wrongDirection ? "text-rose-400" : "text-slate-300"}>
                {change > 0 ? "+" : ""}{formatWeight(change, units)} {unit} · {wrongDirection ? "wrong way" : `${Math.round(pct)}%`}
              </span>
              <span>{formatWeight(settings.targetWeight, units)}</span>
            </div>
            <div className="h-2 rounded-full bg-slate-800 overflow-hidden">
              <div className="h-full rounded-full bg-amber-400" style={{ width: `${pct}%` }} />
            </div>
          </div>
        )}
      </Card>

      {/* Morning weigh-in */}
      <Card>
        <Eyebrow>Morning weigh-in</Eyebrow>
        <div className="flex gap-2 mt-2">
          <input
            value={w}
            onChange={(e) => setW(e.target.value)}
            inputMode="decimal"
            placeholder={units === "imperial" ? "190.4" : "86.4"}
            className="flex-1 bg-slate-800 rounded-xl px-4 py-3 font-mono text-lg outline-none border border-slate-700 focus:border-amber-400"
          />
          <button
            onClick={saveWeight}
            className="px-5 rounded-xl bg-amber-400 text-slate-950 font-semibold"
          >
            {savedFlash ? <Check size={20} /> : "Log"}
          </button>
        </div>
        {todaysWeight && !savedFlash && (
          <div className="text-xs text-slate-500 mt-2 font-mono">logged today: {todaysWeight} {unit} — resave to correct</div>
        )}
      </Card>

      {/* Nutrition at a glance */}
      <Card>
        <div className="flex justify-between items-baseline">
          <Eyebrow color="text-teal-400">Fuel today</Eyebrow>
          <span className="font-mono text-xs text-slate-500">{kcalToday} / {settings.kcalTarget} kcal</span>
        </div>
        <div className="mt-2"><Bar value={kcalToday} max={settings.kcalTarget} color="bg-teal-400" /></div>
        <div className="flex justify-between items-baseline mt-3">
          <span className="text-sm text-slate-300">Protein</span>
          <span className="font-mono text-xs text-slate-500">{protToday} / {settings.proteinTarget} g</span>
        </div>
        <div className="mt-2"><Bar value={protToday} max={settings.proteinTarget} color="bg-sky-400" /></div>
      </Card>

      {/* Next session */}
      <button onClick={goTrain} className="w-full text-left">
        <Card className="flex items-center justify-between">
          <div>
            <Eyebrow color="text-amber-400">Next session</Eyebrow>
            <div className="font-bold mt-1">{sugg.name} <span className="text-slate-500 font-normal">· {sugg.subtitle}</span></div>
          </div>
          <ChevronRight className="text-slate-600" />
        </Card>
      </button>

      {/* Coach nudge */}
      <button onClick={goCoach} className="w-full text-left">
        <Card className={`flex items-center gap-3 ${checkedInToday ? "" : "border-teal-400 border-opacity-30"}`}>
          <ClipboardCheck className={checkedInToday ? "text-slate-600" : "text-teal-400"} size={20} />
          <div className="text-sm">
            {checkedInToday ? (
              <span className="text-slate-500">Checked in with coach today ✓</span>
            ) : (
              <span className="text-slate-200">Daily check-in pending — get your coach's read</span>
            )}
          </div>
        </Card>
      </button>
    </div>
  );
}

function SettingsPanel({ settings, persistSettings, currentAvg, signOut }) {
  const units = settings.units || "metric";
  const unit = weightUnit(units);
  // Draft weights live in DISPLAY units; converted back to kg on save.
  const [s, setS] = useState({
    ...settings,
    startWeight: settings.startWeight != null ? formatWeight(settings.startWeight, units) : "",
    targetWeight: settings.targetWeight != null ? formatWeight(settings.targetWeight, units) : "",
  });
  const [saveMsg, setSaveMsg] = useState(null);
  const upd = (k, v) => setS({ ...s, [k]: v });

  const pickPhase = (p) => {
    if (p === (s.phase || "cut")) return;
    const base = currentAvg != null ? Math.round(currentAvg * 10) / 10 : parseWeightInput(s.startWeight, units);
    // Computed from the actual person (lib/calc.js) — the old presets were absolute
    // numbers for one specific 85 kg man, and deltaKg gave everyone a −12 kg goal.
    const suggested = suggestTargets(
      { sex: settings.sex, birthdate: settings.birthdate, heightCm: settings.heightCm, activityLevel: settings.activityLevel, bodyfatPct: settings.bodyfatPct },
      base,
      p
    );
    // Keep the existing goal only if it points the right way for the new phase;
    // otherwise leave it blank and make the user choose — never invent a goal.
    const prevGoalKg = parseWeightInput(s.targetWeight, units);
    const goalCompatible =
      p === "maintain" ||
      (prevGoalKg != null && (p === "cut" ? prevGoalKg < base : prevGoalKg > base));
    setS({
      ...s,
      phase: p,
      startWeight: base != null ? formatWeight(base, units) : "",
      targetWeight:
        p === "maintain"
          ? base != null ? formatWeight(base, units) : ""
          : goalCompatible ? s.targetWeight : "",
      kcalTarget: suggested ? suggested.kcalTarget : s.kcalTarget,
      proteinTarget: suggested ? suggested.proteinTarget : s.proteinTarget,
    });
  };

  const save = async () => {
    setSaveMsg(null);
    const startKg = parseWeightInput(s.startWeight, units);
    const goalKg = parseWeightInput(s.targetWeight, units);
    const kcal = Number(s.kcalTarget);
    const protein = Number(s.proteinTarget);
    const phase = s.phase || "cut";
    if (![startKg, goalKg].every((v) => v != null) || ![kcal, protein].every(Number.isFinite)) {
      setSaveMsg({ ok: false, text: "Fill in all four numbers before saving." });
      return;
    }
    const check = checkGoal({ phase, currentKg: startKg, goalKg, heightCm: settings.heightCm });
    if (!check.ok) {
      setSaveMsg({ ok: false, text: check.error });
      return;
    }
    const phaseChanged = phase !== (settings.phase || "cut");
    const targetsChanged = kcal !== settings.kcalTarget || protein !== settings.proteinTarget;
    persistSettings({
      ...settings,
      phase,
      kcalTarget: kcal,
      proteinTarget: protein,
      startWeight: Math.round(startKg * 10) / 10,
      targetWeight: Math.round(goalKg * 10) / 10,
      ...(phaseChanged ? { phaseStartedAt: todayKey() } : {}),
    });
    // Provenance for the adjustment engine: manual changes are history too.
    if (phaseChanged || targetsChanged) {
      recordTargetChange("manual", {
        phase,
        kcalTarget: kcal,
        proteinTarget: protein,
        prevKcal: settings.kcalTarget,
        prevProtein: settings.proteinTarget,
        context: { trendWeight: currentAvg },
      }).catch(console.error);
    }
    if (phaseChanged) stampPhaseStart().catch(console.error);
    setSaveMsg({ ok: true, text: check.warning || "Saved" });
    setTimeout(() => setSaveMsg(null), 2500);
  };

  return (
    <Card>
      <Eyebrow>Phase</Eyebrow>
      <div className="flex gap-2 mt-2">
        {Object.keys(PHASES).map((p) => (
          <button
            key={p}
            onClick={() => pickPhase(p)}
            className={`flex-1 py-2 rounded-xl text-sm font-semibold border ${
              (s.phase || "cut") === p
                ? "bg-amber-400 text-slate-950 border-amber-400"
                : "bg-slate-800 text-slate-300 border-slate-700"
            }`}
          >
            {PHASES[p].label}
          </button>
        ))}
      </div>
      {(s.phase || "cut") !== (settings.phase || "cut") && (
        <div className="text-xs text-slate-500 mt-2 leading-relaxed">
          Calories and protein recomputed for the new phase from your profile — adjust below, then save. The progress bar restarts from the new start weight; all history stays.
        </div>
      )}
      <div className="mt-4"><Eyebrow>Targets</Eyebrow></div>
      <div className="flex gap-2 mt-2">
        <TargetField label="kcal / day" value={s.kcalTarget ?? ""} onChange={(v) => upd("kcalTarget", v)} />
        <TargetField label="protein g" value={s.proteinTarget ?? ""} onChange={(v) => upd("proteinTarget", v)} />
      </div>
      <div className="flex gap-2 mt-2">
        <TargetField label={`start ${unit}`} value={s.startWeight} onChange={(v) => upd("startWeight", v)} />
        <TargetField label={`goal ${unit}`} value={s.targetWeight} onChange={(v) => upd("targetWeight", v)} />
      </div>
      <button onClick={save} className="mt-3 w-full py-2 rounded-xl bg-slate-800 text-sm font-semibold border border-slate-700">
        Save phase & targets
      </button>
      {saveMsg && (
        <div className={`text-xs mt-2 leading-relaxed ${saveMsg.ok ? "text-teal-400" : "text-rose-400"}`}>{saveMsg.text}</div>
      )}
      <button
        onClick={signOut}
        className="mt-2 w-full py-2 rounded-xl text-xs text-slate-500 border border-slate-800"
      >
        Sign out
      </button>
    </Card>
  );
}

function TargetField({ label, value, onChange }) {
  return (
    <div className="flex-1">
      <div className="text-xs text-slate-500 mb-1">{label}</div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode="decimal"
        className="w-full bg-slate-800 rounded-lg px-3 py-2 font-mono text-sm border border-slate-700 outline-none focus:border-amber-400"
      />
    </div>
  );
}

/* ---------------- Food ---------------- */

function FoodTab({ days, addMeal: addMealDb, deleteMeal: deleteMealDb, settings, kcalToday, protToday }) {
  const tk = todayKey();
  const meals = (days[tk] && days[tk].meals) || [];
  const carbsToday = meals.reduce((s, m) => s + (Number(m.carbs) || 0), 0);
  const fatToday = meals.reduce((s, m) => s + (Number(m.fat) || 0), 0);
  const [desc, setDesc] = useState("");
  const [name, setName] = useState("");
  const [kcal, setKcal] = useState("");
  const [prot, setProt] = useState("");
  const [carbs, setCarbs] = useState("");
  const [fat, setFat] = useState("");
  const [photo, setPhoto] = useState(null); // { b64, url, mime }
  const [estimating, setEstimating] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const addMeal = async () => {
    const k = Number(kcal), p = Number(prot);
    if ((!k && !p) || saving) return;
    setSaving(true);
    setErr("");
    try {
      await addMealDb(tk, {
        name: name || desc || "Meal",
        kcal: k || 0,
        protein: p || 0,
        carbs: Number(carbs) || 0,
        fat: Number(fat) || 0,
      });
      setDesc(""); setName(""); setKcal(""); setProt(""); setCarbs(""); setFat("");
      setPhoto(null);
    } catch (e) {
      setErr(`Couldn't save meal (${e?.message || "error"}). Try again.`);
    }
    setSaving(false);
  };

  const removeMeal = (meal) => {
    deleteMealDb(tk, meal.id);
  };

  const processBlob = (blob) =>
    new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        try {
          const MAX = 800;
          const scale = Math.min(1, MAX / Math.max(img.width, img.height));
          const canvas = document.createElement("canvas");
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
          URL.revokeObjectURL(url);
          resolve({ b64: dataUrl.split(",")[1], url: dataUrl, mime: "image/jpeg" });
        } catch (e2) {
          URL.revokeObjectURL(url);
          reject(e2);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("decode failed"));
      };
      img.src = url;
    });

  const rawFallback = (file) =>
    new Promise((resolve, reject) => {
      const ok = ["image/jpeg", "image/png", "image/webp", "image/gif"];
      if (!ok.includes(file.type) || file.size > 3000000) return reject(new Error("unsupported format"));
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result);
        resolve({ b64: dataUrl.split(",")[1], url: dataUrl, mime: file.type });
      };
      reader.onerror = () => reject(new Error("read failed"));
      reader.readAsDataURL(file);
    });

  const convertHeic = async (file) => {
    const mod = await import("heic2any");
    const heic2any = mod.default || mod;
    const converted = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.85 });
    const blob = Array.isArray(converted) ? converted[0] : converted;
    return processBlob(blob);
  };

  const onPickPhoto = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    setErr("");
    setProcessing(true);
    const looksHeic = /heic|heif/i.test(file.type || "") || /\.(heic|heif)$/i.test(file.name || "");
    try {
      let result;
      if (looksHeic) {
        result = await convertHeic(file);
      } else {
        try {
          result = await processBlob(file);
        } catch (e1) {
          try {
            result = await convertHeic(file);
          } catch (e2) {
            result = await rawFallback(file);
          }
        }
      }
      setPhoto(result);
    } catch (eFinal) {
      const why = eFinal && eFinal.message ? String(eFinal.message).slice(0, 80) : "unknown";
      setErr(
        `Couldn't convert that photo (HEIC — ${why}). Use the Take photo button instead, or set iPhone Settings → Camera → Formats → Most Compatible so new photos save as JPEG.`
      );
    }
    setProcessing(false);
  };

  const reencode = (dataUrl, max, q) =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, max / Math.max(img.width, img.height));
          const canvas = document.createElement("canvas");
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/jpeg", q).split(",")[1]);
        } catch (e) {
          reject(e);
        }
      };
      img.onerror = () => reject(new Error("re-encode failed"));
      img.src = dataUrl;
    });

  const runEstimate = async (imgB64, mime) => {
    const instruction =
      (imgB64
        ? "Look at this photo of a meal and estimate its nutrition. Judge portion sizes from visual cues like plate size, cutlery, and food depth. "
        : "") +
      (desc.trim() ? `Context from the eater: "${desc.trim()}". ` : "") +
      (imgB64 ? "" : "Use realistic typical portions if unspecified. ") +
      'Your ENTIRE response must be a single raw JSON object and nothing else — no preamble, no markdown, no explanation. Exactly this shape: {"name": "short meal name", "kcal": number, "protein": number, "carbs": number, "fat": number}';
    const content = imgB64
      ? [
          { type: "image", source: { type: "base64", media_type: mime || "image/jpeg", data: imgB64 } },
          { type: "text", text: instruction },
        ]
      : instruction;
    const text = await askClaude([{ role: "user", content }]);
    const match = text.replace(/```json|```/g, "").match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON in response");
    return JSON.parse(match[0]);
  };

  const estimate = async () => {
    if (!desc.trim() && !photo) return;
    setEstimating(true); setErr("");
    try {
      let j;
      if (photo) {
        try {
          j = await runEstimate(photo.b64, photo.mime);
        } catch (e1) {
          const tiny = await reencode(photo.url, 512, 0.7);
          j = await runEstimate(tiny, "image/jpeg");
        }
      } else {
        j = await runEstimate(null, null);
      }
      setName(j.name || desc || "Meal");
      setKcal(String(Math.round(Number(j.kcal) || 0)));
      setProt(String(Math.round(Number(j.protein) || 0)));
      setCarbs(String(Math.round(Number(j.carbs) || 0)));
      setFat(String(Math.round(Number(j.fat) || 0)));
    } catch (e) {
      const msg = e && e.message ? String(e.message).slice(0, 160) : "unknown error";
      setErr(
        photo
          ? `Estimate failed (${msg}). Retry, or add a text description — Estimate works without the photo.`
          : `Estimate failed (${msg}). Retry, or enter numbers manually.`
      );
    }
    setEstimating(false);
  };

  const [diag, setDiag] = useState(null);

  const microImageB64 = () => {
    const c = document.createElement("canvas");
    c.width = 8; c.height = 8;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#888888";
    ctx.fillRect(0, 0, 8, 8);
    return c.toDataURL("image/jpeg", 0.9).split(",")[1];
  };

  const runDiagnostics = async () => {
    setDiag("running");
    const results = [];
    const probe = async (label, messages) => {
      try {
        const t = await askClaude(messages);
        results.push({ label, ok: true, note: t.slice(0, 30) });
      } catch (e) {
        results.push({ label, ok: false, note: String(e && e.message ? e.message : e).slice(0, 90) });
      }
    };
    await probe("Text (simple)", [{ role: "user", content: "Reply with exactly: OK" }]);
    await probe("Text (structured)", [
      { role: "user", content: [{ type: "text", text: "Reply with exactly: OK" }] },
    ]);
    await probe("Tiny image", [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: microImageB64() } },
          { type: "text", text: "Reply with exactly: OK" },
        ],
      },
    ]);
    setDiag(results);
  };

  return (
    <div className="space-y-4">
      <div>
        <Eyebrow color="text-teal-400">Fuel</Eyebrow>
        <h1 className="text-xl font-bold tracking-tight mt-1">Today's intake</h1>
      </div>

      <Card>
        <div className="flex justify-between font-mono text-sm">
          <span className="text-slate-400">kcal</span>
          <span>{kcalToday} <span className="text-slate-500">/ {settings.kcalTarget}</span></span>
        </div>
        <div className="mt-2"><Bar value={kcalToday} max={settings.kcalTarget} color="bg-teal-400" /></div>
        <div className="flex justify-between font-mono text-sm mt-3">
          <span className="text-slate-400">protein</span>
          <span>{protToday} <span className="text-slate-500">/ {settings.proteinTarget} g</span></span>
        </div>
        <div className="mt-2"><Bar value={protToday} max={settings.proteinTarget} color="bg-sky-400" /></div>
        <div className="mt-3 text-xs text-slate-500 font-mono">
          carbs {carbsToday} g · fat {fatToday} g
        </div>
        <div className="mt-1 text-xs text-slate-500 font-mono">
          remaining: {Math.max(0, settings.kcalTarget - kcalToday)} kcal · {Math.max(0, settings.proteinTarget - protToday)} g protein
        </div>
      </Card>

      <Card>
        <Eyebrow>Log a meal</Eyebrow>

        {photo ? (
          <div className="mt-2 relative">
            <img src={photo.url} alt="meal" className="w-full h-40 object-cover rounded-xl border border-slate-700" />
            <button
              onClick={() => setPhoto(null)}
              className="absolute top-2 right-2 w-8 h-8 rounded-full bg-slate-950 bg-opacity-70 flex items-center justify-center text-slate-300"
            >
              <X size={16} />
            </button>
          </div>
        ) : processing ? (
          <div className="mt-2 w-full py-4 rounded-xl border border-dashed border-slate-700 text-slate-500 text-sm flex items-center justify-center gap-2 animate-pulse">
            Converting photo…
          </div>
        ) : (
          <div className="mt-2 flex gap-2">
            <label className="flex-1 py-4 rounded-xl border border-dashed border-teal-400 border-opacity-40 text-slate-300 text-sm flex items-center justify-center gap-2 cursor-pointer active:bg-slate-800">
              <Camera size={18} className="text-teal-400" />
              <span>Take photo</span>
              <input type="file" accept="image/*" capture="environment" onChange={onPickPhoto} className="sr-only" />
            </label>
            <label className="flex-1 py-4 rounded-xl border border-dashed border-slate-700 text-slate-400 text-sm flex items-center justify-center gap-2 cursor-pointer active:bg-slate-800">
              <span>From library</span>
              <input type="file" accept="image/*" onChange={onPickPhoto} className="sr-only" />
            </label>
          </div>
        )}

        <textarea
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder={photo ? "Optional hints — e.g. 'the chicken was about 250g'" : "Or describe it — e.g. 200g chicken breast, rice, salad"}
          rows={2}
          className="w-full mt-2 bg-slate-800 rounded-xl px-3 py-2 text-sm border border-slate-700 outline-none focus:border-teal-400 resize-none"
        />
        <button
          onClick={estimate}
          disabled={estimating || (!desc.trim() && !photo)}
          className="mt-2 w-full py-2 rounded-xl bg-slate-800 border border-slate-700 text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-40"
        >
          <Sparkles size={16} className="text-teal-400" />
          {estimating ? "Analyzing…" : photo ? "Analyze photo" : "Estimate with AI"}
        </button>
        {err && <div className="text-xs text-rose-400 mt-2">{err}</div>}
        {err && (
          <button
            onClick={runDiagnostics}
            disabled={diag === "running"}
            className="mt-2 text-xs text-teal-400 underline"
          >
            {diag === "running" ? "Testing connection…" : "Run AI connection diagnostics"}
          </button>
        )}
        {Array.isArray(diag) && (
          <div className="mt-2 space-y-1 font-mono text-xs">
            {diag.map((d, i) => (
              <div key={i} className={d.ok ? "text-teal-400" : "text-rose-400"}>
                {d.ok ? "✓" : "✗"} {d.label}{d.ok ? "" : ` — ${d.note}`}
              </div>
            ))}
          </div>
        )}
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="meal name"
          className="w-full mt-3 bg-slate-800 rounded-lg px-3 py-2 text-sm border border-slate-700 outline-none"
        />
        <div className="flex gap-2 mt-2">
          <MacroInput value={kcal} set={setKcal} label="kcal" />
          <MacroInput value={prot} set={setProt} label="P g" />
          <MacroInput value={carbs} set={setCarbs} label="C g" />
          <MacroInput value={fat} set={setFat} label="F g" />
        </div>
        <button onClick={addMeal} disabled={saving}
          className="mt-2 w-full py-2 rounded-xl bg-teal-400 text-slate-950 font-semibold flex items-center justify-center gap-1 disabled:opacity-40">
          <Plus size={16} /> {saving ? "Saving…" : "Add"}
        </button>
      </Card>

      {meals.length > 0 && (
        <Card>
          <Eyebrow>Logged today</Eyebrow>
          <div className="mt-2 divide-y divide-slate-800">
            {meals.map((m) => (
              <div key={m.id} className="flex items-center py-2 gap-2">
                <div className="flex-1 text-sm">{m.name}</div>
                <div className="font-mono text-xs text-slate-400">
                  {m.kcal} kcal · {m.protein}P{m.carbs ? ` · ${m.carbs}C` : ""}{m.fat ? ` · ${m.fat}F` : ""}
                </div>
                <button onClick={() => removeMeal(m)} className="text-slate-600 p-1"><Trash2 size={14} /></button>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function MacroInput({ value, set, label }) {
  return (
    <div className="flex-1">
      <input
        value={value}
        onChange={(e) => set(e.target.value)}
        placeholder="0"
        inputMode="numeric"
        className="w-full bg-slate-800 rounded-lg px-2 py-2 text-sm font-mono text-center border border-slate-700 outline-none focus:border-teal-400"
      />
      <div className="text-center text-xs text-slate-600 mt-1 font-mono">{label}</div>
    </div>
  );
}

/* ---------------- Train ---------------- */

function TrainTab({ active, setActive, workouts, onSaveWorkout, lastOfTemplate, suggestedTemplate }) {
  const [saveErr, setSaveErr] = useState("");
  if (active) {
    return (
      <ActiveWorkout
        active={active}
        setActive={setActive}
        onFinish={async (session) => {
          try {
            setSaveErr("");
            await onSaveWorkout(session);
            setActive(null);
          } catch (e) {
            setSaveErr(`Couldn't save workout (${e?.message || "error"}). Your sets are still on screen — try Finish again.`);
          }
        }}
        saveErr={saveErr}
      />
    );
  }

  const start = (templateId) => {
    const prev = lastOfTemplate(templateId);
    const exercises = PROGRAM[templateId].exercises.map((ex) => {
      const prevEx = prev && prev.exercises.find((e) => e.name === ex.name);
      return {
        name: ex.name,
        target: `${ex.sets} × ${ex.reps}${ex.rpe !== "—" ? ` @ RPE ${ex.rpe}` : ""}`,
        prev: prevEx
          ? prevEx.sets.filter((s) => s.w && s.r).map((s) => `${s.w}×${s.r}`).join("  ")
          : null,
        sets: Array.from({ length: ex.sets }, (_, i) => ({
          w: prevEx && prevEx.sets[i] ? prevEx.sets[i].w : "",
          r: "",
          done: false,
        })),
      };
    });
    setActive({ template: templateId, date: todayKey(), exercises, finisher: false });
  };

  const history = [...workouts].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8);

  return (
    <div className="space-y-4">
      <div>
        <Eyebrow color="text-amber-400">Train</Eyebrow>
        <h1 className="text-xl font-bold tracking-tight mt-1">Pick your session</h1>
      </div>

      {SEQUENCE.map((tid) => {
        const t = PROGRAM[tid];
        const last = lastOfTemplate(tid);
        const isNext = tid === suggestedTemplate;
        return (
          <button key={tid} onClick={() => start(tid)} className="w-full text-left">
            <Card className={isNext ? "border-amber-400 border-opacity-40" : ""}>
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-bold">{t.name}
                    {isNext && <span className="ml-2 text-xs font-mono text-amber-400">up next</span>}
                  </div>
                  <div className="text-xs text-slate-500 mt-1">
                    {t.subtitle} · {t.exercises.length} lifts · {t.finisher}
                  </div>
                  {last && <div className="text-xs font-mono text-slate-600 mt-1">last: {shortDate(last.date)}</div>}
                </div>
                <ChevronRight className="text-slate-600" />
              </div>
            </Card>
          </button>
        );
      })}

      {history.length > 0 && (
        <Card>
          <Eyebrow>History</Eyebrow>
          <div className="mt-2 divide-y divide-slate-800">
            {history.map((w) => (
              <div key={w.id} className="py-2 flex justify-between text-sm">
                <span>{PROGRAM[w.template].name}</span>
                <span className="font-mono text-xs text-slate-500">
                  {shortDate(w.date)}{w.finisher ? " · +cardio" : ""}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function ActiveWorkout({ active, setActive, onFinish, saveErr }) {
  const t = PROGRAM[active.template];
  const [state, setState] = useState(active);

  const updSet = (ei, si, field, val) => {
    const next = { ...state, exercises: state.exercises.map((e, i) =>
      i !== ei ? e : { ...e, sets: e.sets.map((s, j) => (j !== si ? s : { ...s, [field]: val })) }
    )};
    setState(next);
  };
  const toggleDone = (ei, si) => {
    const s = state.exercises[ei].sets[si];
    updSet(ei, si, "done", !s.done);
  };
  const addSet = (ei) => {
    const next = { ...state, exercises: state.exercises.map((e, i) =>
      i !== ei ? e : { ...e, sets: [...e.sets, { w: e.sets[e.sets.length - 1]?.w || "", r: "", done: false }] }
    )};
    setState(next);
  };

  const doneSets = state.exercises.reduce((s, e) => s + e.sets.filter((x) => x.done).length, 0);
  const totalSets = state.exercises.reduce((s, e) => s + e.sets.length, 0);

  const finish = () => {
    const session = {
      id: `${state.date}-${state.template}-${Date.now()}`,
      date: state.date,
      template: state.template,
      finisher: state.finisher,
      exercises: state.exercises.map((e) => ({
        name: e.name,
        sets: e.sets.filter((s) => s.w || s.r).map((s) => ({ w: s.w, r: s.r })),
      })),
    };
    onFinish(session);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <Eyebrow color="text-amber-400">{t.subtitle}</Eyebrow>
          <h1 className="text-xl font-bold tracking-tight mt-1">{t.name}</h1>
        </div>
        <button onClick={() => setActive(null)} className="text-slate-500 text-sm">discard</button>
      </div>

      <div className="font-mono text-xs text-slate-500">{doneSets} / {totalSets} sets done</div>

      {state.exercises.map((ex, ei) => (
        <Card key={ei}>
          <div className="flex justify-between items-baseline">
            <div className="font-semibold text-sm">{ex.name}</div>
            <div className="font-mono text-xs text-slate-500">{ex.target}</div>
          </div>
          {ex.prev && (
            <div className="font-mono text-xs text-slate-600 mt-1">last: {ex.prev}</div>
          )}
          <div className="mt-3 space-y-2">
            {ex.sets.map((s, si) => (
              <div key={si} className="flex items-center gap-2">
                <span className="font-mono text-xs text-slate-600 w-4">{si + 1}</span>
                <input
                  value={s.w}
                  onChange={(e) => updSet(ei, si, "w", e.target.value)}
                  placeholder="kg" inputMode="decimal"
                  className="w-20 bg-slate-800 rounded-lg px-3 py-2 font-mono text-sm border border-slate-700 outline-none focus:border-amber-400"
                />
                <span className="text-slate-600 text-xs">×</span>
                <input
                  value={s.r}
                  onChange={(e) => updSet(ei, si, "r", e.target.value)}
                  placeholder="reps" inputMode="numeric"
                  className="w-20 bg-slate-800 rounded-lg px-3 py-2 font-mono text-sm border border-slate-700 outline-none focus:border-amber-400"
                />
                <button
                  onClick={() => toggleDone(ei, si)}
                  className={`ml-auto w-9 h-9 rounded-lg flex items-center justify-center border ${
                    s.done ? "bg-amber-400 border-amber-400 text-slate-950" : "border-slate-700 text-slate-600"
                  }`}
                >
                  <Check size={16} />
                </button>
              </div>
            ))}
          </div>
          <button onClick={() => addSet(ei)} className="mt-2 text-xs text-slate-500 font-mono">+ set</button>
        </Card>
      ))}

      <button
        onClick={() => setState({ ...state, finisher: !state.finisher })}
        className="w-full text-left"
      >
        <Card className={`flex items-center gap-3 ${state.finisher ? "border-teal-400 border-opacity-40" : ""}`}>
          <Flame size={18} className={state.finisher ? "text-teal-400" : "text-slate-600"} />
          <div className="text-sm flex-1">Finisher: {t.finisher}</div>
          {state.finisher && <Check size={16} className="text-teal-400" />}
        </Card>
      </button>

      {saveErr && <div className="text-xs text-rose-400">{saveErr}</div>}
      <button onClick={finish} className="w-full py-3 rounded-xl bg-amber-400 text-slate-950 font-bold">
        Finish & save session
      </button>
    </div>
  );
}

/* ---------------- Trend ---------------- */

function TrendTab({ chartData, settings, trendState, days }) {
  const units = settings.units || "metric";
  const unit = weightUnit(units);
  const goalY = units === "imperial" ? kgToLb(settings.targetWeight) : settings.targetWeight;
  const currentAvg = trendState.trendWeight;
  const weeklyRate = trendState.rate;
  const change = currentAvg != null ? currentAvg - settings.startWeight : null;
  const remaining = currentAvg != null ? settings.targetWeight - currentAvg : null;
  // Only project an arrival when the rate is trustworthy — a low-confidence slope
  // extrapolated over months is a lie with a date on it.
  const eta =
    remaining != null &&
    weeklyRate != null &&
    trendState.confidence === "ok" &&
    Math.abs(weeklyRate) >= 0.1 &&
    remaining / weeklyRate > 0
      ? Math.ceil(remaining / weeklyRate)
      : null;
  const movingAway =
    remaining != null && weeklyRate != null && Math.abs(weeklyRate) >= 0.1 && remaining / weeklyRate < 0;

  // 7-day adherence
  const last7keys = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    last7keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
  }
  const loggedDays = last7keys.filter((k) => days[k] && (days[k].meals || []).length);
  const avgKcal = loggedDays.length
    ? Math.round(loggedDays.reduce((s, k) => s + days[k].meals.reduce((a, m) => a + (Number(m.kcal) || 0), 0), 0) / loggedDays.length)
    : null;
  const avgProt = loggedDays.length
    ? Math.round(loggedDays.reduce((s, k) => s + days[k].meals.reduce((a, m) => a + (Number(m.protein) || 0), 0), 0) / loggedDays.length)
    : null;

  const Stat = ({ label, value, unit }) => (
    <div className="rounded-xl bg-slate-800 bg-opacity-50 p-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="font-mono text-lg font-bold mt-1">
        {value != null ? value : "—"}<span className="text-xs text-slate-500 ml-1">{unit}</span>
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <div>
        <Eyebrow color="text-amber-400">Trend</Eyebrow>
        <h1 className="text-xl font-bold tracking-tight mt-1">The trajectory</h1>
      </div>

      <Card>
        {chartData.length >= 2 ? (
          <div style={{ width: "100%", height: 230 }}>
            <ResponsiveContainer>
              <ComposedChart data={chartData} margin={{ top: 8, right: 4, left: -18, bottom: 0 }}>
                <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
                <XAxis dataKey="label" tick={{ fill: "#64748b", fontSize: 10, fontFamily: "monospace" }} tickLine={false} axisLine={false} minTickGap={24} />
                <YAxis domain={["dataMin - 0.5", "dataMax + 0.5"]} tick={{ fill: "#64748b", fontSize: 10, fontFamily: "monospace" }} tickLine={false} axisLine={false} width={44} />
                <Tooltip
                  contentStyle={{ background: "#0f172a", border: "1px solid #334155", borderRadius: 12, fontFamily: "monospace", fontSize: 12 }}
                  labelStyle={{ color: "#94a3b8" }}
                />
                <ReferenceLine y={goalY} stroke="#2dd4bf" strokeDasharray="4 4" />
                <Line type="monotone" dataKey="weight" name="daily" stroke="#475569" strokeWidth={1} dot={{ r: 1.5, fill: "#475569" }} isAnimationActive={false} />
                <Line type="monotone" dataKey="avg" name="trend" stroke="#fbbf24" strokeWidth={2.5} dot={false} isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="text-sm text-slate-500 py-8 text-center">
            Log a few morning weigh-ins and the trend line appears here.
          </div>
        )}
        <div className="flex gap-4 mt-1 text-xs font-mono text-slate-500">
          <span><span className="text-amber-400">━</span> trend</span>
          <span><span className="text-slate-500">━</span> daily</span>
          <span><span className="text-teal-400">┄</span> goal</span>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-2">
        <Stat label="Change so far" value={change != null ? `${change > 0 ? "+" : ""}${formatWeight(change, units)}` : null} unit={unit} />
        <Stat label="To target" value={remaining != null ? formatWeight(Math.abs(remaining), units) : null} unit={unit} />
        <Stat
          label="Rate (14-day trend)"
          value={weeklyRate != null ? `${trendState.confidence === "low" ? "~" : ""}${formatWeight(weeklyRate, units)}` : null}
          unit={`${unit}/wk`}
        />
        <Stat label="At current trend" value={movingAway ? "wrong way" : eta} unit={eta ? "weeks" : ""} />
        <Stat
          label={`Avg intake (${loggedDays.length}/7 logged)`}
          value={avgKcal}
          unit="kcal"
        />
        <Stat label={`Avg protein (${loggedDays.length}/7 logged)`} value={avgProt} unit="g" />
      </div>

      {/* Generated from lib/lanes.js with the actual bodyweight — the same numbers the
          badge and notifications check, so this text can't drift from the verdicts. */}
      <div className="text-xs text-slate-600 leading-relaxed px-1">
        {laneText(settings.phase, currentAvg, { sex: settings.sex, bodyfatPct: settings.bodyfatPct, experience: settings.experience }, units)}
      </div>
    </div>
  );
}

/* ---------------- Coach ---------------- */

function CoachTab({ chat, persistChat, buildContext, settings, persistSettings }) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const bottomRef = useRef(null);

  useEffect(() => {
    if (bottomRef.current) bottomRef.current.scrollIntoView({ behavior: "smooth" });
  }, [chat, busy]);

  const send = async (text, isCheckin = false) => {
    if (!text.trim() || busy) return;
    setError("");
    const userMsg = { role: "user", content: text };
    const nextChat = [...chat, userMsg];
    persistChat(nextChat);
    addChatMessage("user", text).catch(console.error);
    setInput("");
    setBusy(true);
    try {
      const history = nextChat.slice(-9, -1).map((m) => ({ role: m.role, content: m.content }));
      const speaker = settings.displayName || "The client";
      const apiMessages = [
        ...history,
        { role: "user", content: `${buildContext()}\n\n---\n${speaker} says: ${text}` },
      ];
      const reply = await askClaude(apiMessages);
      const finalChat = [...nextChat, { role: "assistant", content: reply }].slice(-30);
      persistChat(finalChat);
      addChatMessage("assistant", reply).catch(console.error);
      if (isCheckin) persistSettings({ ...settings, lastCheckin: todayKey() });
    } catch (e) {
      setError(`Coach error: ${e && e.message ? String(e.message).slice(0, 140) : "unreachable"} — try again in a moment.`);
    }
    setBusy(false);
  };

  const checkin = () =>
    send(
      "Do my full daily check-in. Go deep on the data: weight trajectory vs the phase lane, calorie and protein adherence, macro balance including carb placement around training days, progression on each main lift, then give me today's single priority and any target adjustment per the phase rules.",
      true
    );

  return (
    <div className="space-y-4 flex flex-col" style={{ minHeight: "70vh" }}>
      <div>
        <Eyebrow color="text-teal-400">Coach</Eyebrow>
        <h1 className="text-xl font-bold tracking-tight mt-1">In your corner</h1>
      </div>

      <button
        onClick={checkin}
        disabled={busy}
        className="w-full py-3 rounded-xl bg-teal-400 text-slate-950 font-bold flex items-center justify-center gap-2 disabled:opacity-40"
      >
        <ClipboardCheck size={18} /> Daily check-in
      </button>

      <div className="flex-1 space-y-3">
        {chat.length === 0 && (
          <div className="text-sm text-slate-500 leading-relaxed py-4">
            Your coach reads your actual logs — weight trend, calories, protein, and lifting numbers — and answers with your plan's rules in mind. Run a check-in each morning after your weigh-in, or ask anything: swap an exercise, rescue a high-calorie day, plan a deload.
          </div>
        )}
        {chat.map((m, i) => (
          <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-xs px-4 py-3 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
                m.role === "user"
                  ? "bg-slate-800 text-slate-100 rounded-br-md"
                  : "bg-slate-900 border border-slate-800 text-slate-200 rounded-bl-md"
              }`}
            >
              {m.content}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex justify-start">
            <div className="px-4 py-3 rounded-2xl bg-slate-900 border border-slate-800 text-slate-500 text-sm font-mono animate-pulse">
              coach is thinking…
            </div>
          </div>
        )}
        {error && <div className="text-xs text-rose-400">{error}</div>}
        <div ref={bottomRef} />
      </div>

      <div className="flex gap-2 sticky bottom-20">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") send(input); }}
          placeholder="Ask your coach…"
          className="flex-1 bg-slate-800 rounded-xl px-4 py-3 text-sm border border-slate-700 outline-none focus:border-teal-400"
        />
        <button
          onClick={() => send(input)}
          disabled={busy || !input.trim()}
          className="px-4 rounded-xl bg-teal-400 text-slate-950 disabled:opacity-40"
        >
          <Send size={18} />
        </button>
      </div>
    </div>
  );
}
