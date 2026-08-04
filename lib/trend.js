// Trend weight + rate of change from raw weigh-ins. Pure and isomorphic — imported by
// the client (Today/Trend tabs) and the cron dispatcher, so there is exactly one
// implementation of this math. It replaces two divergent copies that windowed by
// ENTRIES (slice(-7)) instead of calendar days and overstated an every-other-day
// logger's weekly rate by ~2×.
//
// entries: [{ date: "YYYY-MM-DD", weight: number }] — unsorted ok, gaps ok.
// asOf:    "YYYY-MM-DD" local date to evaluate at (entries after it are ignored).

// EWMA smoothing per calendar day. α=0.25 ≈ mean data age of ~3 days — the same
// effective lag as the old 7-sample average for a daily logger, so the hero number
// doesn't jump on migration.
const ALPHA = 0.25;

const DAY_MS = 86400000;
const toUTC = (d) => Date.parse(`${d}T00:00:00Z`); // date-only math in UTC: DST can't skew day counts
const daysBetween = (a, b) => Math.round((toUTC(b) - toUTC(a)) / DAY_MS);

export function shiftDate(date, days) {
  const d = new Date(toUTC(date) + days * DAY_MS);
  return d.toISOString().slice(0, 10);
}

// Sorted, deduped (last write wins per date), null-safe. Explicit null check, not
// truthiness — a legitimate 0 in some future metric must not vanish.
function clean(entries, asOf) {
  const byDate = new Map();
  for (const e of entries || []) {
    if (!e || e.weight == null || !e.date) continue;
    const w = Number(e.weight);
    if (!Number.isFinite(w)) continue;
    if (asOf && e.date > asOf) continue;
    byDate.set(e.date, w);
  }
  return [...byDate.entries()]
    .map(([date, weight]) => ({ date, weight }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// Gap-tolerant EWMA: a gap of g days applies the per-day smoothing g times
// (1 − (1−α)^g), so sparse logging moves the trend exactly as much as daily logging
// spanning the same days would.
function ewma(sorted) {
  let trend = null;
  let prevDate = null;
  const out = [];
  for (const { date, weight } of sorted) {
    if (trend == null) {
      trend = weight;
    } else {
      const gap = Math.max(1, daysBetween(prevDate, date));
      const a = 1 - Math.pow(1 - ALPHA, gap);
      trend += a * (weight - trend);
    }
    prevDate = date;
    out.push({ date, weight, trend: Math.round(trend * 100) / 100 });
  }
  return out;
}

// OLS slope over a calendar-day window, kg/day. x is the actual date offset, which is
// what makes sparse logging come out right: an every-other-day logger's points span
// twice the x-distance, halving the slope the old entry-indexed math doubled.
function olsSlopePerDay(points) {
  const n = points.length;
  if (n < 2) return null;
  const x0 = toUTC(points[0].date);
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of points) {
    const x = (toUTC(p.date) - x0) / DAY_MS;
    sx += x; sy += p.weight; sxx += x * x; sxy += x * p.weight;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null; // all same day
  return (n * sxy - sx * sy) / denom;
}

/**
 * -> {
 *   trendWeight,          // EWMA over full history up to asOf (null if no data)
 *   lastWeighDate,
 *   rate,                 // kg/week over the trailing window; null when insufficient
 *   nPoints, spanDays,    // window stats; spanDays is inclusive calendar coverage
 *   confidence,           // "insufficient" | "low" | "ok"
 *   pointsNeeded,         // how many more weigh-ins until a rate appears (0 when it has one)
 * }
 *
 * Confidence ladder (windowDays=14 default):
 *   < 4 points or span < 8 days  → insufficient (rate withheld — better no number than a wild one)
 *   ≥ 6 points and span ≥ 11    → ok
 *   anything between            → low (show with a ~, suppress ETA, engine must not act)
 */
export function computeTrend(entries, asOf, { windowDays = 14 } = {}) {
  const sorted = clean(entries, asOf);
  const empty = {
    trendWeight: null, lastWeighDate: null, rate: null,
    nPoints: 0, spanDays: 0, confidence: "insufficient", pointsNeeded: 4,
  };
  if (!sorted.length) return empty;

  const smoothed = ewma(sorted);
  const trendWeight = smoothed[smoothed.length - 1].trend;
  const lastWeighDate = sorted[sorted.length - 1].date;

  const from = shiftDate(asOf, -(windowDays - 1));
  const win = sorted.filter((p) => p.date >= from);
  const nPoints = win.length;
  const spanDays = nPoints ? daysBetween(win[0].date, win[nPoints - 1].date) + 1 : 0;

  if (nPoints < 4 || spanDays < 8) {
    return {
      trendWeight, lastWeighDate, rate: null, nPoints, spanDays,
      confidence: "insufficient", pointsNeeded: Math.max(1, 4 - nPoints),
    };
  }

  const slope = olsSlopePerDay(win);
  const rate = slope == null ? null : Math.round(slope * 7 * 100) / 100;
  const confidence = nPoints >= 6 && spanDays >= 11 ? "ok" : "low";
  return { trendWeight, lastWeighDate, rate, nPoints, spanDays, confidence, pointsNeeded: 0 };
}

// For the chart: every weigh-in with its trend value at that time.
export function trendSeries(entries) {
  return ewma(clean(entries, null));
}
