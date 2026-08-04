// Last-known-good snapshot of loadAll(), for instant cold start and read-only offline.
//
// Without this every app open blocks first paint on five Supabase round-trips behind
// "loading your ledger…". With it we paint the previous snapshot immediately and
// revalidate in the background.
//
// Namespaced per user id so one account's ledger can never surface under another's
// on a shared device. Cleared on sign-out.

// v2: the settings shape gained identity fields and the onboardedAt gate. A v1
// snapshot would boot the app past the wizard with null targets (or worse, land an
// offline pre-migration user in a broken app instead of the wizard). Old entries are
// simply ignored and expire.
const PREFIX = "cutcoach:ledger:v2:";
const keyFor = (userId) => `${PREFIX}${userId}`;

// -> { data, at } | null
export function read(userId) {
  if (!userId || typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(keyFor(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.data) return null;
    return { data: parsed.data, at: parsed.at || 0 };
  } catch {
    return null; // corrupt entry — treat as a miss
  }
}

export function write(userId, data) {
  if (!userId || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(keyFor(userId), JSON.stringify({ at: Date.now(), data }));
  } catch {
    // Quota exceeded or private mode. The cache is an optimisation — never load-bearing.
  }
}

export function clear(userId) {
  if (typeof window === "undefined") return;
  try {
    if (userId) {
      window.localStorage.removeItem(keyFor(userId));
      return;
    }
    // No id to hand: drop every namespace rather than leave a ledger behind.
    Object.keys(window.localStorage)
      .filter((k) => k.startsWith(PREFIX))
      .forEach((k) => window.localStorage.removeItem(k));
  } catch {
    /* nothing useful to do */
  }
}
