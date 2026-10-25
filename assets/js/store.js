/**
 * Cadence — local persistence and derived statistics.
 *
 * Everything lives in localStorage on the device; there is no account and no
 * network round-trip. The store is schema-versioned so future migrations can
 * be applied safely.
 */

import { SOUND_THEMES } from './audio.js';
import { sanitizePlan, emptyPlan, ACTIVITIES } from './plan.js';
import { uid, dateKey } from './util.js';

const KEY = 'cadence.store.v1';

export { uid, dateKey };

export const DEFAULT_PRESETS = [
  { id: 'p25',  label: '25 / 5',   focus: 25, break: 5 },
  { id: 'p50',  label: '50 / 10',  focus: 50, break: 10 },
  { id: 'p90',  label: '90 / 15',  focus: 90, break: 15 },
  { id: 'p15',  label: '15 / 3',   focus: 15, break: 3 },
];

export const DEFAULTS = {
  version: 1,
  settings: {
    mode: 'stopwatch',

    focusMin: 25,
    breakMin: 5,
    longBreakMin: 15,
    longBreakEvery: 4,
    autoBreak: true,
    autoFocus: false,
    soundOnDone: true,
    dailyGoalMin: 120,

    presets: DEFAULT_PRESETS,
    customPresets: [],

    soundEnabled: true,
    soundTheme: 'bell',
    volume: 60,
    tickSound: true,
    uiClicks: true,

    theme: 'void',
    showMillis: false,
    ringGlow: true,
    reduceMotion: false,
    clock24: false,

    wakeLock: true,
    notifications: false,
    focusMode: false,

    autoPlan: false,
    ringOnBlockEnd: true,
    brush: 'self_study',

    // Last-used print style. Remembered so Ctrl+P and the Print button both
    // reopen the sheet exactly as it was left.
    print: { theme: 'light', colour: 'colour', layout: 'full' },
  },
  sessions: [],
  counters: { focus: 0, break: 0 },
  plans: {},
  activities: [],
  saved: [],
};

/* ── helpers ──────────────────────────────────────────────── */

export const DAY_MS = 86400000;

/* ── sanitising ──────────────────────────────────────────── */

/**
 * The store can be replaced by an imported file, so every value that comes
 * back from disk is checked before it is trusted. A number stays a number, a
 * boolean stays a boolean, and anything out of range is clamped.
 */

const BOOL_SETTINGS = [
  'autoBreak', 'autoFocus', 'soundOnDone', 'soundEnabled', 'tickSound',
  'uiClicks', 'showMillis', 'ringGlow', 'reduceMotion', 'clock24',
  'wakeLock', 'notifications', 'focusMode', 'autoPlan', 'ringOnBlockEnd',
];

const NUM_SETTINGS = {
  focusMin: [1, 600],
  breakMin: [1, 120],
  longBreakMin: [1, 120],
  longBreakEvery: [2, 12],
  dailyGoalMin: [0, 960],
  volume: [0, 100],
};

const SOURCES = ['timer', 'stopwatch', 'manual', 'break', 'plan'];

const THEMES = ['void', 'graphite'];

function clampNum(v, min, max) {
  return Math.min(max, Math.max(min, Math.round(v)));
}

function sanitizePreset(p, custom) {
  if (!p || typeof p !== 'object') return null;
  const focus = Number(p.focus);
  const brk = Number(p.break);
  if (!Number.isFinite(focus) || !Number.isFinite(brk)) return null;
  const label = typeof p.label === 'string' && p.label.trim()
    ? p.label.trim().slice(0, 24)
    : `${clampNum(focus, 1, 600)} / ${clampNum(brk, 1, 120)}`;
  return {
    id: typeof p.id === 'string' && p.id ? p.id : uid('p'),
    label,
    focus: clampNum(focus, 1, 600),
    break: clampNum(brk, 1, 120),
    custom: !!custom,
  };
}

/** Rebuild the settings from defaults, keeping only values of the right type. */
export function sanitizeSettings(raw) {
  const out = structuredClone(DEFAULTS.settings);
  if (!raw || typeof raw !== 'object') return out;

  for (const key of BOOL_SETTINGS) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key];
  }
  for (const [key, [min, max]] of Object.entries(NUM_SETTINGS)) {
    const v = Number(raw[key]);
    if (Number.isFinite(v)) out[key] = clampNum(v, min, max);
  }
  if (raw.mode === 'timer' || raw.mode === 'stopwatch') out.mode = raw.mode;
  if (typeof raw.soundTheme === 'string' && SOUND_THEMES.some(t => t.id === raw.soundTheme)) {
    out.soundTheme = raw.soundTheme;
  }
  if (THEMES.includes(raw.theme)) out.theme = raw.theme;
  if (typeof raw.brush === 'string' && raw.brush) out.brush = raw.brush.slice(0, 60);
  const print = raw.print && typeof raw.print === 'object' ? raw.print : {};
  out.print = {
    theme: print.theme === 'dark' ? 'dark' : 'light',
    colour: print.colour === 'grey' ? 'grey' : 'colour',
    layout: print.layout === 'zen' ? 'zen' : 'full',
  };
  if (Array.isArray(raw.presets)) {
    const list = raw.presets.map(p => sanitizePreset(p, false)).filter(Boolean);
    out.presets = list.length ? list : structuredClone(DEFAULT_PRESETS);
  }
  if (Array.isArray(raw.customPresets)) {
    out.customPresets = raw.customPresets.map(p => sanitizePreset(p, true)).filter(Boolean);
  }
  return out;
}

/** Rebuild the session log from disk or from an imported file. */
export function sanitizeSessions(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const s of list) {
    if (!s || typeof s !== 'object') continue;
    const durationMs = Number(s.durationMs);
    if (!Number.isFinite(durationMs)) continue;
    const start = Number(s.start);
    out.push({
      id: typeof s.id === 'string' && s.id ? s.id : uid('s'),
      start: Number.isFinite(start) ? start : Date.now(),
      durationMs: Math.max(0, Math.round(durationMs)),
      mode: typeof s.mode === 'string' ? s.mode : (s.source === 'manual' ? 'manual' : 'timer'),
      label: typeof s.label === 'string' ? s.label.trim().slice(0, 60) : '',
      source: SOURCES.includes(s.source) ? s.source : 'timer',
      // A live session is one that is still growing — it is written to disk
      // while it runs, so closing the app never loses the time.
      live: !!s.live,
      plannedMs: Math.max(0, Math.round(Number(s.plannedMs) || 0)),
    });
  }
  return out;
}

/** Rebuild the plans that were saved to the timer from the plan page. */
export function sanitizeSavedPlans(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const date = typeof raw.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) ? raw.date : '';
    if (!date) continue;
    const plan = sanitizePlan(raw, date);
    out.push({
      id: typeof raw.id === 'string' && raw.id ? raw.id : uid('sp'),
      date,
      label: typeof raw.label === 'string' ? raw.label.slice(0, 80) : '',
      savedAt: Number(raw.savedAt) || Date.now(),
      blocks: plan.blocks,
      tasks: plan.tasks,
      imported: plan.imported,
    });
  }
  return out.slice(0, 12);
}

/** Rebuild the custom activities. */
export function sanitizeActivities(list) {
  if (!Array.isArray(list)) return [];
  const known = new Set(ACTIVITIES.map(a => a.key));
  const out = [];
  for (const a of list) {
    if (!a || typeof a !== 'object') continue;
    const key = typeof a.key === 'string' ? a.key.slice(0, 60) : '';
    if (!key || known.has(key)) continue;
    known.add(key);
    out.push({
      key,
      label: typeof a.label === 'string' && a.label.trim() ? a.label.trim().slice(0, 40) : key,
      kind: a.kind === 'study' || a.kind === 'rest' || a.kind === 'life' ? a.kind : 'study',
    });
  }
  return out;
}

/** Rebuild every plan, keyed by its date. */
export function sanitizePlans(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [date, plan] of Object.entries(raw)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const clean = sanitizePlan(plan, date);
    if (clean.blocks.length || clean.tasks.length || clean.imported) out[date] = clean;
  }
  return out;
}

export function isoDateInput(ts) {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/* ── store ───────────────────────────────────────────────── */

function deepMerge(base, patch) {
  if (Array.isArray(base)) return Array.isArray(patch) ? patch.slice() : base.slice();
  if (base && typeof base === 'object') {
    const out = { ...base };
    if (patch && typeof patch === 'object') {
      for (const k of Object.keys(patch)) {
        out[k] = k in base ? deepMerge(base[k], patch[k]) : patch[k];
      }
    }
    return out;
  }
  return patch === undefined ? base : patch;
}

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const parsed = JSON.parse(raw);
    const merged = deepMerge(structuredClone(DEFAULTS), parsed);
    merged.settings = sanitizeSettings(parsed.settings);
    merged.sessions = sanitizeSessions(parsed.sessions);
    merged.counters = {
      focus: Number(parsed.counters?.focus) || 0,
      break: Number(parsed.counters?.break) || 0,
    };
    merged.plans = sanitizePlans(parsed.plans);
    merged.activities = sanitizeActivities(parsed.activities);
    merged.saved = sanitizeSavedPlans(parsed.saved);
    return merged;
  } catch (err) {
    console.warn('[Cadence] store unreadable, starting fresh', err);
    return structuredClone(DEFAULTS);
  }
}

const STORE_KEYS = ['version', 'settings', 'sessions', 'counters', 'plans', 'activities', 'saved'];

let saveTimer = null;
let pendingState = null;
const pendingKeys = new Set();
/** Whether the most recent write reached localStorage at all. */
let persistOk = true;

/** True when the last attempted write failed (quota, private mode, …). */
export function persistFailed() {
  return !persistOk;
}

/**
 * Write only the given top-level keys, merging everything else with what is
 * already on the disk.
 *
 * Every page keeps the whole store in memory, and two pages can be open at
 * once — the clock here, the plan there. A full-state write from one tab
 * would silently roll back the other tab's work, so the hot paths (sessions,
 * counters, plans, saved plans) write only the keys they actually own and
 * take the rest of the store fresh from the disk.
 */
function writeKeys(state, keys) {
  try {
    const disk = load();
    const merged = {};
    for (const k of STORE_KEYS) {
      merged[k] = keys.includes(k) ? state[k] : disk[k];
    }
    localStorage.setItem(KEY, JSON.stringify(merged));
    persistOk = true;
    return true;
  } catch (err) {
    console.warn('[Cadence] could not persist', err);
    persistOk = false;
    return false;
  }
}

/* Batching: every writer shares one pending batch — one timer, one set of
   keys, one state reference. A saveKeys for `counters` that arrives 1 ms
   after a pending `sessions` write must *add* to the batch, never cancel it
   (a plain clearTimeout would drop the row-close that was about to land). */

function flushPending() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const state = pendingState;
  const keys = [...pendingKeys];
  pendingState = null;
  pendingKeys.clear();
  if (!state || !keys.length) return;
  writeKeys(state, keys);
}

function scheduleWrite(state, keys, delay) {
  // A different state object means the snapshot was replaced outright
  // (import / erase) — land whatever was still pending first, for that
  // object's keys to stay honest.
  if (pendingState && pendingState !== state) flushPending();
  pendingState = state;
  for (const k of keys) pendingKeys.add(k);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushPending, delay);
}

/** Debounced scoped write. */
export function saveKeys(state, keys) {
  scheduleWrite(state, keys, 120);
}

/** Immediate scoped write — use before pagehide or when feedback is shown. */
export function saveKeysNow(state, keys) {
  scheduleWrite(state, keys, 0);
  flushPending();
}

export function save(state) {
  scheduleWrite(state, STORE_KEYS, 120);
}

export function saveNow(state) {
  scheduleWrite(state, STORE_KEYS, 0);
  flushPending();
}

export function clearStore() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

/* ── plans ───────────────────────────────────────────────── */

/** The plan for a date — always an object, never undefined. */
export function getPlan(state, date) {
  return state.plans[date] || emptyPlan(date);
}

/** Write a plan back into the store. */
export function setPlan(state, date, plan) {
  state.plans[date] = { ...plan, date, updatedAt: Date.now() };
  // Immediate scoped write — the plan page flashes "Saved locally" right after
  // this, so the write must land now and must not clobber other keys.
  saveKeysNow(state, ['plans']);
  return state.plans[date];
}

/* ── sessions ────────────────────────────────────────────── */

/**
 * Add a session to the log.
 *
 * A *live* session is one that is still running: it is written to disk with
 * a duration of zero and grows while the timer runs. That is what makes the
 * time safe — closing the tab, reloading the page or locking the phone can
 * never lose a session, because the session was already on the disk.
 */
export function addSession(state, {
  durationMs, mode, label = '', source = 'timer', start = Date.now(), live = false, plannedMs = 0,
}) {
  if (!live && (!durationMs || durationMs < 1000)) return null;
  const session = {
    id: uid('s'),
    start,
    durationMs: Math.max(0, Math.round(durationMs || 0)),
    mode,
    label: label.trim().slice(0, 60),
    source,
    plannedMs: Math.max(0, Math.round(plannedMs || 0)),
  };
  if (live) session.live = true;
  state.sessions.push(session);
  saveKeys(state, ['sessions']);
  return session;
}

/** Change a session in place — used to grow and close a live session. */
export function updateSession(state, id, patch) {
  const s = state.sessions.find(x => x.id === id);
  if (!s) return null;
  if (patch.durationMs != null) s.durationMs = Math.max(0, Math.round(patch.durationMs));
  if (patch.label != null) s.label = String(patch.label).slice(0, 60);
  if (patch.live != null) s.live = !!patch.live;
  if (patch.start != null) s.start = patch.start;
  saveKeys(state, ['sessions']);
  return s;
}

/**
 * Close every session that was still live when the app went away.
 *
 * A live session means “the timer was on and the app died”. The time it had
 * banked is real, so it is kept — capped at the length the session was
 * supposed to run, because a timer left alone for a night is not a study
 * session of nine hours.
 *
 * `exceptId` is the session of the run that is being picked up again — it is
 * left alone, because it is still counting.
 */
export function closeOrphanSessions(state, now = Date.now(), exceptId = '') {
  let changed = false;
  for (const s of state.sessions) {
    if (!s.live || s.id === exceptId) continue;
    const elapsed = Math.max(0, now - s.start);
    const capped = s.plannedMs > 0 ? Math.min(elapsed, s.plannedMs) : elapsed;
    s.durationMs = Math.round(capped);
    s.live = false;
    changed = true;
  }
  if (changed) saveKeys(state, ['sessions']);
  return changed;
}

export function removeSession(state, id) {
  const i = state.sessions.findIndex(s => s.id === id);
  if (i >= 0) { state.sessions.splice(i, 1); saveKeys(state, ['sessions']); }
}

export function recentSessions(state, limit = 60) {
  return state.sessions.slice().sort((a, b) => b.start - a.start).slice(0, limit);
}

/* ── plans saved for the timer ────────────────────────────── */

/**
 * Save a plan for the clock.
 *
 * This is what “Save to timer” does on the plan page: it takes the day that
 * is on screen and parks a copy of it in the store, so the clock's settings
 * menu can offer it later — to run, or to copy back onto a day.
 */
export function savePlanForTimer(state, plan, label = '') {
  if (!plan || !Array.isArray(plan.blocks) || !plan.blocks.length) return null;
  const date = plan.date || dateKey(Date.now());
  const existing = state.saved.find(s => s.date === date);
  const clean = sanitizePlan({ ...plan, date }, date);
  const record = {
    id: existing ? existing.id : uid('sp'),
    date,
    label: String(label || plan.imported?.label || '').slice(0, 80),
    savedAt: Date.now(),
    blocks: clean.blocks,
    tasks: clean.tasks,
    imported: clean.imported,
  };
  if (existing) {
    state.saved = state.saved.map(s => (s.id === existing.id ? record : s));
  } else {
    state.saved.push(record);
  }
  // Keep the list short — the newest twelve are the ones that matter.
  state.saved = state.saved.slice(-12);
  saveKeysNow(state, ['saved']);
  return record;
}

export function removeSavedPlan(state, id) {
  const before = state.saved.length;
  state.saved = state.saved.filter(s => s.id !== id);
  if (state.saved.length !== before) saveKeysNow(state, ['saved']);
}

export function getSavedPlan(state, id) {
  return state.saved.find(s => s.id === id) || null;
}

/* ── derived stats ───────────────────────────────────────── */

export function computeStats(state) {
  const now = Date.now();
  const todayStart = startOfDay(now);
  const yesterdayStart = todayStart - DAY_MS;

  const perDay = new Map();
  let todayMs = 0;
  let todayCount = 0;
  let weekMs = 0;
  let weekCount = 0;
  const weekStart = todayStart - 6 * DAY_MS;

  for (const s of state.sessions) {
    // Breaks are rest, not study — they never count towards the goal.
    if (s.source === 'break') continue;
    const key = dateKey(s.start);
    perDay.set(key, (perDay.get(key) || 0) + s.durationMs);

    if (s.start >= todayStart) { todayMs += s.durationMs; todayCount++; }
    if (s.start >= weekStart) { weekMs += s.durationMs; weekCount++; }
  }

  // streak: consecutive days with study time, ending today or yesterday
  let streak = 0;
  let cursor = perDay.has(dateKey(todayStart)) ? todayStart : yesterdayStart;
  if (!perDay.has(dateKey(cursor))) cursor = 0;
  while (cursor && perDay.has(dateKey(cursor))) {
    streak++;
    cursor -= DAY_MS;
  }

  const last7 = [];
  for (let i = 6; i >= 0; i--) {
    const ts = todayStart - i * DAY_MS;
    const d = new Date(ts);
    last7.push({
      ts,
      ms: perDay.get(dateKey(ts)) || 0,
      label: ['S', 'M', 'T', 'W', 'T', 'F', 'S'][d.getDay()],
      isToday: i === 0,
    });
  }

  const goalMs = (state.settings.dailyGoalMin || 0) * 60000;
  const studied = state.sessions.filter(s => s.source !== 'break');

  return {
    todayMs,
    todayCount,
    weekMs,
    weekCount,
    streak,
    goalMs,
    goalPct: goalMs > 0 ? Math.min(1, todayMs / goalMs) : (todayMs > 0 ? 1 : 0),
    last7,
    totalMs: studied.reduce((a, s) => a + s.durationMs, 0),
    totalCount: studied.length,
  };
}
