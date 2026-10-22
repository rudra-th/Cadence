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
    view: 'clock',

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
  },
  sessions: [],
  counters: { focus: 0, break: 0 },
  plans: {},
  activities: [],
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
  if (raw.view === 'timer' || raw.view === 'plan' || raw.view === 'clock') out.view = raw.view;
  if (typeof raw.soundTheme === 'string' && SOUND_THEMES.some(t => t.id === raw.soundTheme)) {
    out.soundTheme = raw.soundTheme;
  }
  if (THEMES.includes(raw.theme)) out.theme = raw.theme;
  if (typeof raw.brush === 'string' && raw.brush) out.brush = raw.brush.slice(0, 60);
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
    if (!Number.isFinite(durationMs) || durationMs <= 0) continue;
    const start = Number(s.start);
    out.push({
      id: typeof s.id === 'string' && s.id ? s.id : uid('s'),
      start: Number.isFinite(start) ? start : Date.now(),
      durationMs: Math.round(durationMs),
      mode: typeof s.mode === 'string' ? s.mode : (s.source === 'manual' ? 'manual' : 'timer'),
      label: typeof s.label === 'string' ? s.label.trim().slice(0, 60) : '',
      source: SOURCES.includes(s.source) ? s.source : 'timer',
    });
  }
  return out;
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
    return merged;
  } catch (err) {
    console.warn('[Cadence] store unreadable, starting fresh', err);
    return structuredClone(DEFAULTS);
  }
}

let saveTimer = null;
export function save(state) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (err) {
      console.warn('[Cadence] could not persist', err);
    }
  }, 120);
}

export function saveNow(state) {
  clearTimeout(saveTimer);
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* quota / private mode */ }
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
  save(state);
  return state.plans[date];
}

/* ── sessions ────────────────────────────────────────────── */

export function addSession(state, { durationMs, mode, label = '', source = 'timer', start = Date.now() }) {
  if (!durationMs || durationMs < 1000) return null;
  const session = {
    id: uid('s'),
    start,
    durationMs: Math.round(durationMs),
    mode,
    label: label.trim().slice(0, 60),
    source,
  };
  state.sessions.push(session);
  save(state);
  return session;
}

export function removeSession(state, id) {
  const i = state.sessions.findIndex(s => s.id === id);
  if (i >= 0) { state.sessions.splice(i, 1); save(state); }
}

export function recentSessions(state, limit = 60) {
  return state.sessions.slice().sort((a, b) => b.start - a.start).slice(0, limit);
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
