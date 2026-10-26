/**
 * Cadence — the clock.
 *
 * The clock is one of two pages: this one runs the timer, the plan page
 * writes the day down. They share one store and one runtime, so a run that
 * starts on the plan page keeps counting when the clock opens.
 *
 * Timing is derived from wall-clock timestamps, never from tick counts, so the
 * clock stays exact when the tab is throttled, backgrounded or the screen is
 * off — and the time is written to disk while it runs, so nothing is lost
 * when the app is closed without the timer being stopped.
 */

import { sound } from './audio.js';
import {
  DEFAULTS, load, save, saveNow, saveKeys, saveKeysNow, clearStore,
  addSession, updateSession, removeSession, recentSessions, computeStats,
  closeOrphanSessions, isoDateInput, uid, getPlan, setPlan,
  removeSavedPlan, storeErrorNotice,
  sanitizeSettings, sanitizeSessions, sanitizePlans, sanitizeActivities, sanitizeSavedPlans,
} from './store.js';
import { importTimetable as importTimetableFile, importErrorMessage } from './timetable-import.js';
import {
  blockAt, planSummary, dayProgress,
} from './plan.js';
import {
  clamp, pad2, dateKey, startOfDayKey, minutesOfDay, clockLabel, labelDate,
} from './util.js';
import { applyTheme } from './theme.js';
import { readRuntime, writeRuntime, clearRuntime } from './runtime.js';

/* ═══════════════════════════════════════════════════════════
   Constants
   ═══════════════════════════════════════════════════════════ */

const RING_C = 741.42;          // 2πr for r=118
const RING_R = 118;
const RING_CX = 130;
const RING_CY = 130;

const APP_VERSION = '1.5.0';    // keep in step with sw.js VERSION

const QUICK_DURATIONS = [5, 15, 25, 30, 45, 50, 60, 90];

/* ═══════════════════════════════════════════════════════════
   DOM
   ═══════════════════════════════════════════════════════════ */

const $ = (id) => document.getElementById(id);

const el = {
  body: document.body,
  dial: $('dial'),
  ringProgress: $('ringProgress'),
  ringHead: $('ringHead'),
  timeDisplay: $('timeDisplay'),
  timeLead: $('timeLead'),
  timeSep: $('timeSep'),
  timeTail: $('timeTail'),
  timeFrac: $('timeFrac'),
  metaLabel: $('metaLabel'),
  metaText: $('metaText'),
  segmented: document.querySelector('.segmented'),
  tabs: [...document.querySelectorAll('.segmented__btn')],
  primaryBtn: $('primaryBtn'),
  primaryIcon: $('primaryIcon'),
  primaryLabel: $('primaryLabel'),
  stopBtn: $('stopBtn'),
  resetBtn: $('resetBtn'),
  todayLine: $('todayLine'),

  // The day card under the clock
  agenda: $('agenda'),
  agendaState: $('agendaState'),
  agendaCount: $('agendaCount'),
  agendaBody: $('agendaBody'),
  agendaSession: $('agendaSession'),
  agendaSubject: $('agendaSubject'),
  agendaWhen: $('agendaWhen'),
  agendaProgress: $('agendaProgress'),
  agendaBar: $('agendaBar'),
  agendaWork: $('agendaWork'),
  agendaWorkHead: $('agendaWorkHead'),
  agendaTasks: $('agendaTasks'),
  agendaSubjects: $('agendaSubjects'),
  agendaFoot: $('agendaFoot'),
  agendaContinue: $('agendaContinue'),
  agendaContinueText: $('agendaContinueText'),

  settingsBtn: $('settingsBtn'),
  settingsPanel: $('settingsPanel'),
  closeSettings: $('closeSettings'),
  scrim: $('scrim'),
  drawerTabs: [...document.querySelectorAll('.drawer__tab')],
  panels: [...document.querySelectorAll('.panel')],

  durationPop: $('durationPop'),
  durationPresets: $('durationPresets'),
  durationInput: $('durationInput'),
  durationApply: $('durationApply'),
  durationClose: $('durationClose'),

  presetChips: $('presetChips'),
  addPreset: $('addPreset'),

  statGrid: $('statGrid'),
  weekChart: $('weekChart'),
  sessionList: $('sessionList'),
  sessionCount: $('sessionCount'),

  addDialog: $('addDialog'),
  addForm: $('addForm'),
  addHours: $('addHours'),
  addMinutes: $('addMinutes'),
  addLabel: $('addLabel'),
  addDate: $('addDate'),
  addSubmit: $('addSubmit'),
  addCancel: $('addCancel'),
  addClose: $('addClose'),

  // plan — drawer panel
  ttDrop: $('ttDrop'),
  ttPick: $('ttPick'),
  ttFile: $('ttFile'),
  ttBanner: $('ttBanner'),
  ttLoaded: $('ttLoaded'),
  ttDate: $('ttDate'),
  ttSummary: $('ttSummary'),
  ttTasks: $('ttTasks'),
  ttList: $('ttList'),
  ttCount: $('ttCount'),
  ttClear: $('ttClear'),
  ttActivities: $('ttActivities'),
  ttContinue: $('ttContinue'),
  ttSaved: $('ttSaved'),
  ttSavedList: $('ttSavedList'),
  ttSavedCount: $('ttSavedCount'),

  toast: $('toast'),
};

/* ═══════════════════════════════════════════════════════════
   State
   ═══════════════════════════════════════════════════════════ */

let state = load();

const T = {
  mode: 'stopwatch',
  status: 'idle',          // idle | running | paused
  kind: 'focus',           // focus | break
  startedAt: 0,
  accumulated: 0,
  target: 25 * 60000,
  subject: '',             // label of the plan block being run
  sessionId: '',           // id of the plan block being run
};

let stats = computeStats(state);
let rafId = null;
let tickId = null;
let lastFrameAt = 0;
let timeoutId = null;
let wakeLock = null;
let deferredInstall = null;
let lastTimeText = '';
let lastTitle = '';
let lastRingVisible = null;
let lastTodayText = '';
let lastAgendaSig = '';
let agendaLive = null;      // the block the card is counting through right now
let popoverReturnFocus = null;  // where focus goes back when the popover shuts
let lastTickSecond = -1;
let toastTimer = null;
let lastFocusTarget = null;
let planTimerId = null;
let drawerHideTimer = null;

/* The session row that is growing while the timer runs. It is written to
   disk as it goes, so closing the app never loses the time. */
let liveSessionId = '';
let lastLiveSync = 0;

/* ═══════════════════════════════════════════════════════════
   Small helpers
   ═══════════════════════════════════════════════════════════ */

function formatTime(ms, showMs) {
  const total = Math.max(0, ms);
  const totalSec = Math.floor(total / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const base = h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
  if (!showMs) return base;
  const cs = Math.floor((total % 1000) / 10);
  return `${base}.${pad2(cs)}`;
}

/**
 * Splits a duration for the two-tone readout: the minutes carry the visual
 * weight, the seconds recede. Digits are never animated — they snap.
 */
function formatTimeParts(ms, showMs) {
  const total = Math.max(0, ms);
  const totalSec = Math.floor(total / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return {
    lead: h > 0 ? `${h}:${pad2(m)}` : pad2(m),
    sep: ':',
    tail: pad2(s),
    frac: showMs ? `.${pad2(Math.floor((total % 1000) / 10))}` : '',
  };
}

function formatDuration(ms) {
  const total = Math.round(ms / 1000);
  // Below a minute, seconds say more than a rounded “0m”.
  if (total < 60) return `${total}s`;
  const h = Math.floor(total / 3600);
  const m = Math.round((total - h * 3600) / 60);
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

function formatClock(ts) {
  const d = new Date(ts);
  const h24 = d.getHours();
  if (state.settings.clock24) return `${pad2(h24)}:${pad2(d.getMinutes())}`;
  const h = h24 % 12 || 12;
  return `${h}:${pad2(d.getMinutes())} ${h24 < 12 ? 'AM' : 'PM'}`;
}

function formatDay(ts) {
  const now = new Date();
  const d = new Date(ts);
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  if (sameDay(d, now)) return 'Today';
  const y = new Date(now.getTime() - 86400000);
  if (sameDay(d, y)) return 'Yesterday';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/* ═══════════════════════════════════════════════════════════
   Appearance
   ═══════════════════════════════════════════════════════════ */

function applyAppearance() {
  const s = state.settings;
  el.body.dataset.reduceMotion = s.reduceMotion ? 'true' : 'false';
  el.body.dataset.focus = s.focusMode ? 'true' : 'false';
  el.dial.dataset.glow = s.ringGlow ? 'on' : 'off';
  el.timeDisplay.dataset.ms = s.showMillis ? 'true' : 'false';
  applyTheme(s.theme);
}

/* ═══════════════════════════════════════════════════════════
   Timer engine
   ═══════════════════════════════════════════════════════════ */

function elapsedMs() {
  return T.accumulated + (T.status === 'running' ? Math.max(0, Date.now() - T.startedAt) : 0);
}

/** The moment the current run really began. */
function runStart() {
  if (T.status === 'running' && T.startedAt) return T.startedAt;
  return Date.now() - T.accumulated;
}

function persistRuntime() {
  writeRuntime({
    mode: T.mode, status: T.status, kind: T.kind,
    startedAt: T.startedAt, accumulated: T.accumulated, target: T.target,
    subject: T.subject, sessionId: T.sessionId,
  });
}

/* ═══════════════════════════════════════════════════════════
   The live session
   ═══════════════════════════════════════════════════════════

   A session is written to the store the moment the timer starts, and its
   duration grows while the timer runs. Nothing is lost if the app is
   closed, reloaded or killed — the time is already on the disk.
*/

/** Find the session row that belongs to this run, if it is still there. */
function adoptLiveSession(startedAt) {
  const found = state.sessions.find(s => s.live && s.start === startedAt);
  if (!found) return false;
  liveSessionId = found.id;
  return true;
}

/** Open a session for a run that is just starting. */
function beginLiveSession() {
  if (T.kind === 'break') return;            // a break is rest, not study
  if (liveSessionId) return;
  const startedAt = T.startedAt || Date.now();
  if (adoptLiveSession(startedAt)) return;
  const s = addSession(state, {
    durationMs: 0,
    mode: T.mode,
    label: T.subject || '',
    source: T.mode === 'timer' ? 'timer' : 'stopwatch',
    start: startedAt,
    live: true,
    plannedMs: T.mode === 'timer' ? T.target : 0,
  });
  liveSessionId = s ? s.id : '';
}

/** Write the time banked so far into the live session. */
function syncLiveSession(force = false) {
  if (!liveSessionId) return;
  const now = Date.now();
  if (!force && now - lastLiveSync < 5000) return;
  lastLiveSync = now;
  updateSession(state, liveSessionId, { durationMs: Math.round(elapsedMs()) });
  // Scoped flush: a full-state write here would roll back whatever the plan
  // tab changed while this one sat in the background.
  if (force) saveKeysNow(state, ['sessions', 'counters']);
}

/** Close the live session with its final length. */
function closeLiveSession(durationMs) {
  if (!liveSessionId) return;
  const ms = Math.max(0, Math.round(durationMs));
  if (ms < 1000) {
    // Too short to be a session — it never really happened, so it goes away
    // instead of leaving a zero-length entry in the log.
    removeSession(state, liveSessionId);
  } else {
    updateSession(state, liveSessionId, { durationMs: ms, live: false });
  }
  liveSessionId = '';
}

function restoreRuntime() {
  const r = readRuntime();
  if (!r) return;

  T.mode = r.mode === 'timer' ? 'timer' : 'stopwatch';
  T.kind = r.kind === 'break' ? 'break' : 'focus';
  T.target = Number(r.target) || state.settings.focusMin * 60000;
  T.accumulated = Number(r.accumulated) || 0;
  T.startedAt = Number(r.startedAt) || 0;
  T.status = r.status === 'running' ? 'running' : (r.status === 'paused' ? 'paused' : 'idle');
  T.subject = typeof r.subject === 'string' ? r.subject.slice(0, 60) : '';
  T.sessionId = typeof r.sessionId === 'string' ? r.sessionId : '';

  if (T.status === 'running') {
    const elapsed = elapsedMs();
    if (T.mode === 'timer' && elapsed >= T.target) {
      // Completed while the app was closed — record it faithfully. Only the
      // time the clock really ran counts, capped at the length of the run.
      const kind = T.kind;
      const subject = T.subject;
      const sessionId = T.sessionId;
      const startedAt = T.startedAt || Date.now() - T.accumulated;
      const planned = plannedSession(sessionId);
      const logged = Math.min(elapsed, T.target);
      adoptLiveSession(startedAt);
      T.status = 'idle'; T.accumulated = 0; T.startedAt = 0;
      T.subject = ''; T.sessionId = '';
      clearRuntime();
      finishSession(kind, logged, { silent: true, noChain: true, subject, sessionId, start: startedAt });
      showToast(subject
        ? `${subject} session ended, ${formatClock(planned ? planned.end : Date.now())}`
        : 'A session completed while you were away');
    } else {
      // Pick the run back up — the seconds it spent closed still count.
      adoptLiveSession(T.startedAt);
      beginLiveSession();
      scheduleTimeout();
      startLoop();
    }
  }
  syncModeUI();
  updateControls();
}

function scheduleTimeout() {
  clearTimeout(timeoutId);
  if (T.status !== 'running' || T.mode !== 'timer') return;
  const remaining = T.target - elapsedMs();
  const fire = () => {
    if (T.status !== 'running' || T.mode !== 'timer') return;
    // Only the time the clock really ran is logged — the run cannot be longer
    // than its own target, however long the app was closed.
    finishSession(T.kind, Math.min(elapsedMs(), T.target));
  };
  // A target that is already used up must still end the session — otherwise
  // the clock would sit at 00:00 forever.
  if (remaining <= 0) { timeoutId = setTimeout(fire, 0); return; }
  timeoutId = setTimeout(fire, remaining);
}

function start(opts = {}) {
  if (T.status === 'running') return;
  if (opts.target) {
    T.target = opts.target;
    T.accumulated = 0;
  } else if (T.mode === 'timer' && T.status === 'idle') {
    // The long break comes around on the *focus* counter — finishSession()
    // counts completed focus sessions, so this must read the same counter.
    T.target = (T.kind === 'break'
      ? (state.counters.focus > 0 && state.counters.focus % Math.max(1, state.settings.longBreakEvery) === 0
          ? state.settings.longBreakMin : state.settings.breakMin)
      : state.settings.focusMin) * 60000;
    T.accumulated = 0;
  }
  T.startedAt = Date.now();
  T.status = 'running';
  sound.unlock();
  sound.play('start');
  beginLiveSession();
  persistRuntime();
  scheduleTimeout();
  requestWakeLock();
  startLoop();
  updateControls();
}

function pause() {
  if (T.status !== 'running') return;
  T.accumulated = elapsedMs();
  T.startedAt = 0;
  T.status = 'paused';
  clearTimeout(timeoutId);
  sound.play('pause');
  persistRuntime();
  syncLiveSession(true);
  releaseWakeLock();
  stopLoop();
  render();
  updateControls();
}

function reset() {
  const wasRunning = T.status === 'running';
  const ran = elapsedMs();
  T.status = 'idle';
  T.accumulated = 0;
  T.startedAt = 0;
  T.subject = '';
  T.sessionId = '';
  // Resetting a break puts the timer back on a focus session.
  T.kind = 'focus';
  clearTimeout(timeoutId);
  clearRuntime();
  // The time the clock really ran stays in the log — a reset throws the run
  // away, it does not rewrite history.
  closeLiveSession(ran);
  releaseWakeLock();
  stopLoop();
  if (wasRunning) sound.play('reset');
  render();
  updateControls();
}

function stop() {
  const ms = elapsedMs();
  const kind = T.kind;
  const subject = T.subject;
  const sessionId = T.sessionId;
  // The run really began when the clock began — not when the plan said it
  // would. A session that was joined late or stopped early is logged with
  // its own span so the record never claims time that was not spent.
  const startedAt = (T.status === 'running' ? T.startedAt : Date.now() - T.accumulated) || Date.now();
  T.status = 'idle';
  T.accumulated = 0;
  T.startedAt = 0;
  T.subject = '';
  T.sessionId = '';
  clearTimeout(timeoutId);
  clearRuntime();
  releaseWakeLock();
  stopLoop();
  if (ms >= 1000) {
    finishSession(kind, ms, {
      source: T.mode === 'timer' ? 'timer' : 'stopwatch',
      manual: true,
      subject,
      sessionId,
      start: startedAt,
    });
  } else {
    // Too short to count as a session — it is removed again.
    closeLiveSession(0);
    // A break that was abandoned must not make the next Start another break.
    T.kind = 'focus';
    sound.play('reset');
  }
  render();
  updateControls();
}

/**
 * Record a finished session and decide what happens next.
 *
 * `opts.subject` / `opts.sessionId` carry the plan block that was running, so
 * the log and the announcement speak with the right name.
 *
 * The rule the whole app is built on: **only the time the clock really ran is
 * logged**. A plan block says when the work was supposed to happen — it never
 * adds that time to the record by itself.
 */
function finishSession(kind, durationMs, opts = {}) {
  const s = state.settings;
  const isBreak = kind === 'break';
  const subject = (opts.subject ?? T.subject ?? '').trim();
  const sessionId = opts.sessionId ?? T.sessionId ?? '';
  const planned = plannedSession(sessionId);
  // The length of the run is the length that was actually spent.
  const loggedMs = Math.max(0, Math.round(durationMs));
  // The record starts when the work actually began — never when the plan said
  // it would.
  const loggedStart = opts.start != null ? opts.start : runStart();

  // Breaks are rest, not study — they stay out of the log and the stats.
  if (!isBreak) {
    if (liveSessionId) {
      // The session was already written to the disk and has been growing —
      // close it rather than writing a second one.
      closeLiveSession(loggedMs);
    } else {
      addSession(state, {
        durationMs: loggedMs,
        mode: opts.manual ? T.mode : 'timer',
        label: subject,
        source: opts.manual ? (T.mode === 'timer' ? 'timer' : 'stopwatch') : 'timer',
        start: loggedStart,
      });
    }
  }

  state.counters[kind] = (state.counters[kind] || 0) + 1;
  if (sessionId) markBlockDone(sessionId);
  saveKeys(state, ['counters']);
  stats = computeStats(state);
  renderToday();
  renderStats();
  renderPlanPanel();

  if (!opts.silent) {
    if (opts.manual) {
      // Stopped by hand — the session did not reach its planned end, so it is
      // never announced as a completion.
      sound.play('reset');
      showToast(subject
        ? `${subject} stopped · ${formatDuration(loggedMs)}`
        : `Stopped · ${formatDuration(loggedMs)}`);
    } else if (subject) {
      announceBlockEnd(subject, loggedMs, planned ? planned.end : Date.now());
    } else {
      if (s.soundOnDone) sound.play('complete');
      notify(
        isBreak ? 'Break finished' : 'Focus session complete',
        isBreak ? 'Time to get back to it.' : `${formatDuration(loggedMs)} of focused work logged.`
      );
    }
  }

  // Chain to the next phase if the user asked for it. A plan block never
  // chains — the plan itself decides what runs next.
  const wantBreak = isBreak ? s.autoFocus : s.autoBreak;
  if (!opts.manual && !opts.noChain && !sessionId && wantBreak) {
    if (isBreak) {
      T.kind = 'focus';
      T.target = s.focusMin * 60000;
    } else {
      const long = state.counters.focus % Math.max(1, s.longBreakEvery) === 0;
      T.kind = 'break';
      T.target = (long ? s.longBreakMin : s.breakMin) * 60000;
    }
    T.accumulated = 0;
    T.startedAt = Date.now();
    T.status = 'running';
    // A chained focus session must get its live row straight away, same as
    // one started by hand — breaks are rest and are skipped inside.
    beginLiveSession();
    persistRuntime();
    scheduleTimeout();
    requestWakeLock();
    startLoop();
    showToast(isBreak ? 'Break over — back to focus' : (T.kind === 'break' ? 'Nice work — break time' : 'Focus session complete'));
  } else {
    T.status = 'idle';
    T.accumulated = 0;
    T.startedAt = 0;
    T.subject = '';
    T.sessionId = '';
    // The next session that is started by hand is a focus session — a break
    // that just ended must not turn the next start into another break.
    T.kind = 'focus';
    clearRuntime();
    if (!opts.manual && !opts.silent && !subject) showToast(isBreak ? 'Break complete' : 'Session complete');
  }

  updateControls();
  render();
}

/* ═══════════════════════════════════════════════════════════
   Loop + rendering
   ═══════════════════════════════════════════════════════════ */

/**
 * The render loop has two drivers.
 *
 * `requestAnimationFrame` is the primary one — it gives the progress ring a
 * smooth, frame-locked sweep. But rAF is not guaranteed to run: it is starved
 * in occluded windows, in headless browsers, and on some mobile builds. If
 * that happened the readout would freeze while the clock kept running, which
 * looks like a broken timer.
 *
 * So a plain interval acts as a watchdog: it only paints when rAF has gone
 * quiet. Every value is derived from absolute timestamps, so a throttled
 * interval (background tabs are clamped to 1/s, sometimes 1/min) can never
 * introduce drift — it only affects how promptly the screen refreshes.
 */
function loopFrame() {
  rafId = null;
  if (T.status !== 'running') return;
  lastFrameAt = performance.now();
  render();
  rafId = requestAnimationFrame(loopFrame);
}

function startLoop() {
  // The two drivers are independent. Each one is (re)started only when it is
  // actually missing, so a chain that was interrupted somewhere else can never
  // leave the readout frozen.
  if (!tickId) {
    tickId = setInterval(() => {
      if (T.status !== 'running') return;
      if (performance.now() - lastFrameAt < 400) return; // rAF is healthy
      render();
    }, 250);
  }
  if (!rafId) rafId = requestAnimationFrame(loopFrame);
}

function stopLoop() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  if (tickId) { clearInterval(tickId); tickId = null; }
}

function render() {
  const s = state.settings;
  const ms = elapsedMs();

  let shown = ms;
  let progress = 0;
  let ringVisible = true;

  if (T.mode === 'timer') {
    shown = Math.max(0, T.target - ms);
    progress = T.target > 0 ? clamp(ms / T.target, 0, 1) : 0;
  } else {
    progress = stats.goalMs > 0 ? clamp(stats.todayMs / stats.goalMs, 0, 1) : 0;
    ringVisible = stats.goalMs > 0;
  }

  const text = formatTime(shown, s.showMillis);
  if (text !== lastTimeText) {
    lastTimeText = text;
    const p = formatTimeParts(shown, s.showMillis);
    el.timeLead.textContent = p.lead;
    el.timeSep.textContent = p.sep;
    el.timeTail.textContent = p.tail;
    el.timeFrac.textContent = p.frac;
  }
  // The title follows the clock *and* the run state — a stopped stopwatch must
  // give the static title back, even when the digits did not change.
  const title = T.status === 'running' ? `${text} · Cadence` : 'Cadence — plan the day, run the day';
  if (title !== lastTitle) {
    lastTitle = title;
    document.title = title;
  }

  // Ring
  el.ringProgress.style.strokeDashoffset = String(RING_C * (1 - progress));
  if (lastRingVisible !== ringVisible) {
    lastRingVisible = ringVisible;
    el.ringProgress.style.opacity = ringVisible ? '1' : '0';
    el.ringProgress.parentElement.querySelector('.dial__track').style.opacity = ringVisible ? '1' : '0';
  }

  const angle = progress * Math.PI * 2;
  // The whole ring is rotated -90° so progress starts at twelve o'clock.
  // The head is painted in that same rotated frame — otherwise it would sit a
  // quarter turn behind the tip of the stroke.
  const hx = RING_CX + RING_R * Math.cos(angle);
  const hy = RING_CY + RING_R * Math.sin(angle);
  el.ringHead.setAttribute('cx', hx.toFixed(2));
  el.ringHead.setAttribute('cy', hy.toFixed(2));
  el.ringHead.dataset.show = progress > 0.004 && progress < 0.999 ? 'true' : 'false';

  // Meta
  const mins = Math.round(T.target / 60000);
  if (T.mode === 'timer') {
    // A plan block owns its own length — the duration popover must not fight
    // it, so the label is not interactive while one is running.
    const interactive = !T.sessionId;
    el.metaText.textContent = T.subject
      || (T.kind === 'break' ? `${mins} min break` : `${mins} min focus`);
    if (el.metaLabel.dataset.interactive !== (interactive ? 'true' : 'false')) {
      el.metaLabel.dataset.interactive = interactive ? 'true' : 'false';
      el.metaLabel.disabled = !interactive;
    }
  } else {
    if (stats.goalMs > 0) {
      el.metaText.textContent = `${formatDuration(stats.todayMs)} / ${formatDuration(stats.goalMs)}`;
    } else {
      el.metaText.textContent = 'Stopwatch';
    }
    if (el.metaLabel.dataset.interactive !== 'false') {
      el.metaLabel.dataset.interactive = 'false';
      el.metaLabel.disabled = true;
    }
  }

  // Countdown ticks in the final seconds
  if (T.mode === 'timer' && T.status === 'running' && shown > 0 && shown <= 5000 && s.tickSound && s.soundEnabled) {
    const sec = Math.ceil(shown / 1000);
    if (sec !== lastTickSecond) {
      lastTickSecond = sec;
      sound.play('tick');
    }
  } else {
    lastTickSecond = -1;
  }

  el.dial.dataset.running = T.status === 'running' ? 'true' : 'false';
  // Keep the session on the disk up to date while it runs — this is what
  // makes the time safe when the app is closed without the timer being stopped.
  if (T.status === 'running') syncLiveSession();
  // The day card counts in the same frame, so it never lags the readout.
  updateAgendaClock();
  renderToday();
}

function updateControls() {
  const running = T.status === 'running';
  const paused = T.status === 'paused';

  el.primaryLabel.textContent = running ? 'Pause' : (paused ? 'Resume' : 'Start');
  el.primaryBtn.dataset.variant = running ? 'pause' : 'start';
  el.primaryIcon.innerHTML = running
    ? '<path d="M8.5 5.5h3.2v13H8.5zM12.9 5.5h3.2v13h-3.2z" fill="currentColor"/>'
    : '<path d="M8 5.5v13l11-6.5z" fill="currentColor"/>';
  el.stopBtn.hidden = !running && !paused;
  el.resetBtn.textContent = 'Reset';
  renderAgenda();
}

function renderToday() {
  const parts = [];
  if (T.status === 'running' || T.status === 'paused') {
    parts.push(`${T.mode === 'timer' ? 'Session' : 'Stopwatch'} ${formatTime(elapsedMs(), false)}`);
  }
  if (stats.todayCount > 0) {
    parts.push(`Today ${formatDuration(stats.todayMs)}`);
    parts.push(`${stats.todayCount} session${stats.todayCount === 1 ? '' : 's'}`);
  } else if (!parts.length) {
    parts.push('Ready when you are');
  }
  const text = parts.join(' · ');
  if (text !== lastTodayText) {
    lastTodayText = text;
    el.todayLine.textContent = text;
  }
  renderAgenda();
}

/* ═══════════════════════════════════════════════════════════
   Mode switching
   ═══════════════════════════════════════════════════════════ */

function setMode(mode) {
  const next = mode === 'timer' ? 'timer' : 'stopwatch';
  if (T.status === 'running' || T.status === 'paused') {
    // A running session keeps its own length — switching the mode only
    // changes what the *next* start will do.
    T.mode = next;
    state.settings.mode = next;
    save(state);
    syncModeUI();
    render();
    return;
  }
  T.mode = next;
  state.settings.mode = next;
  if (next === 'timer') T.target = state.settings.focusMin * 60000;
  save(state);
  syncModeUI();
  render();
}

function syncModeUI() {
  el.segmented.dataset.mode = T.mode;
  el.tabs.forEach(t => t.setAttribute('aria-pressed', String(t.dataset.mode === T.mode)));
}

/* ═══════════════════════════════════════════════════════════
   Wake lock + notifications
   ═══════════════════════════════════════════════════════════ */

async function requestWakeLock() {
  if (!state.settings.wakeLock) return;
  if (!('wakeLock' in navigator)) return;
  if (T.status !== 'running') return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
  } catch {
    wakeLock = null;
  }
}

function releaseWakeLock() {
  if (wakeLock) {
    try { wakeLock.release(); } catch { /* ignore */ }
    wakeLock = null;
  }
}

async function notify(title, body, tag = 'cadence-session') {
  if (!state.settings.notifications) return;
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) {
        await reg.showNotification(title, { body, tag, icon: './assets/icons/icon-192.png', badge: './assets/icons/icon-192.png' });
        return;
      }
    }
    new Notification(title, { body, tag, icon: './assets/icons/icon-192.png' });
  } catch {
    /* notifications are a nicety, never a failure */
  }
}

/* ═══════════════════════════════════════════════════════════
   The plan — the thing both halves share
   ═══════════════════════════════════════════════════════════ */

function planFor(date) {
  return getPlan(state, date);
}

function todayPlan() {
  return planFor(dateKey(Date.now()));
}

/** The plan block with this id, anywhere in the store. */
function plannedSession(id) {
  if (!id) return null;
  for (const [date, plan] of Object.entries(state.plans)) {
    const b = plan.blocks.find(x => x.id === id);
    if (!b) continue;
    const dayStart = startOfDayKey(date);
    return {
      id: b.id,
      subject: b.label,
      start: dayStart + b.startMin * 60000,
      end: dayStart + b.endMin * 60000,
      durationMs: (b.endMin - b.startMin) * 60000,
      isBreak: b.kind === 'rest',
    };
  }
  return null;
}

/** Remember that a block has been dealt with, so it is never run twice. */
function markBlockDone(id) {
  for (const plan of Object.values(state.plans)) {
    if (!plan.blocks.some(b => b.id === id)) continue;
    plan.done = plan.done || {};
    plan.done[id] = true;
    saveKeysNow(state, ['plans']);
    return;
  }
}

/**
 * Announce the end of a block.
 *
 * The wording is the contract with the person studying: which block ended
 * and when. The duration rides along in the notification body.
 */
function announceBlockEnd(subject, durationMs, endTs) {
  const title = `${subject} session ended`;
  const clock = formatClock(endTs);
  if (state.settings.ringOnBlockEnd) {
    // The sound engine honours the global sound switch by itself.
    sound.play('complete');
    notify(title, `Ended ${clock} · ${formatDuration(durationMs)}`, 'cadence-plan');
  }
  showToast(`${title}, ${clock}`);
}

/**
 * Read a timetable PDF and turn it into a plan.
 *
 * The PDF is parsed entirely on the device — nothing is uploaded anywhere.
 * The very same reader is used by the plan page, so a timetable imported from
 * either one shows up in both.
 */
async function importTimetable(file) {
  if (!file) return;
  const banner = el.ttBanner;
  banner.hidden = false;
  banner.dataset.tone = 'warn';
  banner.textContent = 'Reading the PDF…';

  try {
    const result = await importTimetableFile(state, file);
    banner.hidden = true;
    renderPlanPanel();
    planTick();
    showToast(`Imported ${result.blocks} blocks · ${result.label}`);
  } catch (err) {
    console.warn('[Cadence] timetable import failed', err);
    banner.hidden = false;
    banner.dataset.tone = 'warn';
    banner.textContent = importErrorMessage(err);
  }
}

/**
 * The autopilot.
 *
 * It wakes on a slow heartbeat and whenever the app comes back to the
 * foreground, and it does three things:
 *
 *   1. starts the clock for the block that is running right now
 *   2. marks blocks that ended while the app was not watching, so they are
 *      never run late — but never logs them, because no time was spent on them
 *   3. keeps the panel and the home line in sync
 *
 * Everything it decides is derived from absolute timestamps, so a throttled
 * or delayed heartbeat can never shift a block by more than the heartbeat
 * itself.
 */
function planTick() {
  const now = Date.now();
  const date = dateKey(now);
  const plan = planFor(date);
  const mins = minutesOfDay(now);

  if (plan.blocks.length) {
    // 1 — run whatever is running now.
    const current = blockAt(plan.blocks, mins);
    if (current && state.settings.autoPlan) {
      // A block that has already been logged is finished — never run it twice.
      const finished = !!(plan.done && plan.done[current.id]);
      if (!finished && T.status === 'idle' && T.sessionId !== current.id) {
        startPlanBlock(current, { auto: true, date });
      }
    }

    // 2 — pick up blocks that ended without the app watching. They are
    // marked as dealt with, but they are *not* logged: nobody was working
    // them, so no time was spent on them.
    plan.done = plan.done || {};
    let changed = false;
    for (const b of plan.blocks) {
      const endTs = startOfDayKey(date) + b.endMin * 60000;
      if (now < endTs) continue;
      if (plan.done[b.id]) continue;
      plan.done[b.id] = true;
      changed = true;
    }
    if (changed) save(state);
  }

  // 3 — paint.
  renderPlanPanel();
  renderAgenda();
}

/**
 * Run a block on the clock.
 *
 * Started by hand it runs for its full length; started by the autopilot it
 * joins the block where it already is.
 *
 * A live run is never thrown away silently. Starting the timetable while
 * something else is on the clock asks first — the autopilot, which has no one
 * to ask, simply waits for the clock to be idle.
 */
function startPlanBlock(block, opts = {}) {
  const date = opts.date || dateKey(Date.now());
  const full = (block.endMin - block.startMin) * 60000;
  if (!full) return;

  if (T.status === 'running' || T.status === 'paused') {
    if (T.sessionId === block.id) {
      if (T.status === 'paused') {
        start();
        showToast(`Resumed ${block.label}`);
      } else {
        showToast(`${block.label} is already running`);
      }
      return;
    }
    if (opts.auto) return;
    const runningName = T.subject || (T.mode === 'timer' ? 'the current timer' : 'the stopwatch');
    const ok = window.confirm(
      `“${runningName}” is still running. Stop it and start “${block.label}”?`
    );
    if (!ok) return;
    // Ending the run by hand keeps the time that was really spent in the log.
    stop();
  }

  closePopover();

  if (T.mode !== 'timer') {
    T.mode = 'timer';
    state.settings.mode = 'timer';
    syncModeUI();
  }

  let remaining = opts.remaining || full;
  if (opts.auto) {
    const now = Date.now();
    const endTs = startOfDayKey(date) + block.endMin * 60000;
    remaining = Math.max(1000, endTs - now);
  }

  T.kind = block.kind === 'rest' ? 'break' : 'focus';
  T.subject = block.label;
  T.sessionId = block.id;
  T.accumulated = 0;

  start({ target: remaining });
  showToast(`${block.label} started`);
}

/**
 * Carry on with the timetable.
 *
 * The clock picks up the block that is running right now — or, when there is
 * none, the next one. Either way the timer starts, and the next session is
 * shown underneath it.
 */
function continueTimetable(date = dateKey(Date.now())) {
  const plan = planFor(date);
  if (!plan.blocks.length) {
    showToast('Nothing is planned for that day');
    return;
  }
  const isToday = date === dateKey(Date.now());
  const mins = minutesOfDay(Date.now());
  const open = plan.blocks.filter(b => !(plan.done && plan.done[b.id]));
  const { current, next } = dayProgress(open, mins, isToday);
  const block = current || next;
  if (!block) {
    showToast('That day is done — nothing left to run');
    return;
  }
  let remaining = (block.endMin - block.startMin) * 60000;
  if (current && isToday) {
    const endTs = startOfDayKey(date) + block.endMin * 60000;
    remaining = Math.max(1000, endTs - Date.now());
  }
  startPlanBlock(block, { date, remaining });
}

/* ── Plan panel (drawer) ─────────────────────────────────── */

function renderPlanPanel() {
  const plan = todayPlan();
  const summary = planSummary(plan);
  const has = plan.blocks.length > 0;
  el.ttLoaded.hidden = !has;
  renderSavedPlans();
  if (!has) {
    el.ttList.innerHTML = '';
    el.ttTasks.hidden = true;
    el.ttTasks.textContent = '';
    el.ttCount.textContent = '';
    el.ttDate.textContent = '';
    el.ttSummary.textContent = '';
    if (el.ttContinue) el.ttContinue.hidden = true;
    renderActivityList();
    return;
  }

  const now = Date.now();
  const mins = minutesOfDay(now);
  el.ttDate.textContent = plan.imported?.label || 'Your plan for today';
  el.ttCount.textContent = `· ${plan.blocks.length}`;
  el.ttSummary.textContent = `${formatDuration(summary.studyMin * 60000)} study`
    + ` · ${formatDuration(summary.freeMin * 60000)} free`
    + ` · ${summary.tasksDone}/${summary.tasks} tasks`;

  const tasks = Array.isArray(plan.imported?.subjects) ? plan.imported.subjects : [];
  el.ttTasks.hidden = tasks.length === 0;
  el.ttTasks.textContent = tasks.length
    ? `Tasks · ${tasks.map(t => `${t.name} ${t.done}/${t.total}`).join(' · ')}`
    : '';

  if (el.ttContinue) el.ttContinue.hidden = false;

  el.ttList.innerHTML = '';
  for (const b of plan.blocks) {
    const phase = mins >= b.endMin ? 'done' : (mins >= b.startMin ? 'active' : 'upcoming');
    const row = document.createElement('div');
    row.className = 'tt-row';
    row.dataset.phase = phase;

    const time = document.createElement('span');
    time.className = 'tt-row__time';
    time.textContent = `${clockLabel(b.startMin)} – ${clockLabel(b.endMin)}`;

    const subject = document.createElement('span');
    subject.className = 'tt-row__subject';
    subject.textContent = b.label;

    const dur = document.createElement('span');
    dur.className = 'tt-row__dur';
    dur.textContent = formatDuration((b.endMin - b.startMin) * 60000);

    row.append(time, subject, dur);
    el.ttList.appendChild(row);
  }
  renderActivityList();
}

/**
 * The plans that were saved for the clock from the plan page.
 *
 * Each one can be copied back onto its day, or run straight away — the timer
 * picks up the block that is due, just like “Continue Timetable” does.
 */
function renderSavedPlans() {
  const wrap = el.ttSaved;
  const list = el.ttSavedList;
  if (!wrap || !list) return;
  const saved = state.saved || [];
  wrap.hidden = saved.length === 0;
  if (el.ttSavedCount) el.ttSavedCount.textContent = saved.length ? `· ${saved.length}` : '';
  list.innerHTML = '';

  for (const rec of saved.slice().reverse()) {
    const row = document.createElement('div');
    row.className = 'savedrow';

    const main = document.createElement('div');
    main.className = 'savedrow__main';
    const title = document.createElement('span');
    title.className = 'savedrow__title';
    title.textContent = rec.label || labelDate(rec.date, { weekday: 'long', day: 'numeric', month: 'long' });
    const sub = document.createElement('span');
    sub.className = 'savedrow__sub';
    sub.textContent = `${rec.blocks.length} block${rec.blocks.length === 1 ? '' : 's'}`
      + ` · ${labelDate(rec.date, { month: 'short', day: 'numeric' })}`;
    main.append(title, sub);

    const actions = document.createElement('div');
    actions.className = 'savedrow__actions';

    const use = document.createElement('button');
    use.type = 'button';
    use.className = 'btn btn--soft btn--sm';
    use.textContent = 'Use';
    use.title = 'Copy this plan onto its day';
    use.addEventListener('click', () => {
      setPlan(state, rec.date, {
        ...getPlan(state, rec.date),
        date: rec.date,
        blocks: rec.blocks,
        tasks: rec.tasks,
        imported: rec.imported,
        done: {},
      });
      save(state);
      renderPlanPanel();
      renderAgenda();
      showToast(`Plan copied to ${labelDate(rec.date, { month: 'short', day: 'numeric' })}`);
    });

    const run = document.createElement('button');
    run.type = 'button';
    run.className = 'btn btn--soft btn--sm';
    run.textContent = 'Run';
    run.title = 'Start the clock on this plan';
    run.addEventListener('click', () => {
      const isToday = rec.date === dateKey(Date.now());
      const mins = minutesOfDay(Date.now());
      const { current, next } = dayProgress(rec.blocks, mins, isToday);
      const block = current || next;
      if (!block) {
        showToast('Nothing left to run on that plan');
        return;
      }
      let remaining = (block.endMin - block.startMin) * 60000;
      if (current && isToday) {
        const endTs = startOfDayKey(rec.date) + block.endMin * 60000;
        remaining = Math.max(1000, endTs - Date.now());
      }
      startPlanBlock(block, { date: rec.date, remaining });
      closeDrawer();
    });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'icon-btn icon-btn--sm';
    del.setAttribute('aria-label', `Remove saved plan ${rec.label || rec.date}`);
    del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" '
      + 'stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    del.addEventListener('click', () => {
      removeSavedPlan(state, rec.id);
      renderSavedPlans();
      showToast('Saved plan removed');
    });

    actions.append(use, run, del);
    row.append(main, actions);
    list.appendChild(row);
  }
}

/** The user's own activities, with a way to remove them. */
function renderActivityList() {
  const list = el.ttActivities;
  if (!list) return;
  list.innerHTML = '';
  const custom = state.activities || [];
  if (!custom.length) {
    list.innerHTML = '<p class="hint">Only the built-in activities are in use. '
      + 'Add your own in the planner.</p>';
    return;
  }
  for (const a of custom) {
    const row = document.createElement('div');
    row.className = 'actrow';
    const name = document.createElement('span');
    name.className = 'actrow__name';
    name.textContent = a.label;
    const kind = document.createElement('span');
    kind.className = 'actrow__kind';
    kind.textContent = a.kind;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'icon-btn icon-btn--sm';
    del.setAttribute('aria-label', `Remove ${a.label}`);
    del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" '
      + 'stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    del.addEventListener('click', () => {
      state.activities = state.activities.filter(x => x.key !== a.key);
      save(state);
      renderActivityList();
      showToast(`Removed "${a.label}"`);
    });
    row.append(name, kind, del);
    list.appendChild(row);
  }
}

/* ── The day card under the clock ─────────────────────────── */

/**
 * The card under the clock: the session that is due now (or next), the work
 * that is still open, and a way back into the timetable.
 *
 * It is deliberately quiet. The clock stays the hero; the card only answers
 * the two questions a person has while a timer runs — *what am I supposed to
 * be doing* and *what is left* — without making them open the drawer.
 *
 * Rebuilding the card is guarded by a signature, because `renderToday()` runs
 * on every animation frame. The live countdown and the progress bar are
 * painted separately, so a task button never loses focus just because a
 * minute ticked over.
 */
function renderAgenda() {
  const now = Date.now();
  const date = dateKey(now);
  const plan = planFor(date);
  const mins = minutesOfDay(now);
  const done = plan.done || {};

  // A block that has already been run is finished — the card should look
  // ahead instead of offering it again.
  const open = plan.blocks.filter(b => !done[b.id]);
  const { current, next } = dayProgress(open, mins, true);
  const block = current || next;

  const tasks = (Array.isArray(plan.tasks) ? plan.tasks : []).filter(t => !t.done);
  const subjects = (Array.isArray(plan.imported?.subjects) ? plan.imported.subjects : [])
    .filter(s => Number(s.total) > 0 && Number(s.done) < Number(s.total));
  const hasBlocks = plan.blocks.length > 0;
  const hasWork = tasks.length > 0 || subjects.length > 0;

  if (!hasBlocks && !hasWork) {
    // An empty day keeps the card: it is the one place on this page that
    // shows the way into the planner, and a fresh install has no other way
    // of finding it. The signature keeps the idle ticks from rebuilding it.
    if (lastAgendaSig === 'empty') return;
    lastAgendaSig = 'empty';
    el.agenda.hidden = false;
    el.agenda.dataset.state = 'empty';
    el.agenda.dataset.live = 'false';
    el.agendaState.textContent = 'Ready when you are';
    el.agendaCount.textContent = 'Nothing planned for today';
    el.agendaSession.hidden = true;
    el.agendaProgress.hidden = true;
    el.agendaBar.style.transform = 'scaleX(0)';
    el.agendaWork.hidden = true;
    el.agendaBody.dataset.single = 'true';
    el.agendaContinue.hidden = true;
    el.agendaFoot.dataset.single = 'true';
    agendaLive = null;
    return;
  }
  el.agenda.hidden = false;

  const phase = current ? 'now' : (block ? 'next' : 'done');
  const sig = [
    hasBlocks ? '1' : '0',
    open.map(b => b.id).join(','),
    current ? current.id : '',
    next ? next.id : '',
    T.status,
    T.sessionId || '',
    tasks.map(t => `${t.id}:${t.text}`).join(','),
    subjects.map(s => `${s.name}:${s.done}/${s.total}`).join(','),
  ].join('|');

  if (sig === lastAgendaSig) {
    updateAgendaClock();
    return;
  }
  lastAgendaSig = sig;

  el.agenda.dataset.state = phase;
  el.agenda.dataset.live = current ? 'true' : 'false';
  el.agendaState.textContent = phase === 'now' ? 'Now' : (phase === 'next' ? 'Next up' : 'Plan complete');

  const taskWord = tasks.length === 1 ? 'task' : 'tasks';
  const subjectWord = subjects.length === 1 ? 'subject' : 'subjects';
  el.agendaCount.textContent = tasks.length
    ? `${tasks.length} ${taskWord} left`
    : (subjects.length
        ? `${subjects.length} ${subjectWord} left`
        : (hasBlocks ? 'All clear' : ''));

  // ── the session column ──
  const showSession = !!block || hasBlocks;
  el.agendaSession.hidden = !showSession;

  if (block) {
    const range = `${clockLabel(block.startMin)} – ${clockLabel(block.endMin)}`;
    el.agendaSubject.textContent = block.label;
    el.agendaProgress.hidden = !current;
    agendaLive = {
      current: !!current,
      startMin: block.startMin,
      endMin: block.endMin,
      range,
      lastWhen: '',
    };
    updateAgendaClock();
  } else if (hasBlocks) {
    // Every block has been dealt with: keep the card, but say so plainly.
    el.agendaSubject.textContent = 'Plan complete';
    el.agendaWhen.textContent = hasWork
      ? 'The timetable is done — these are the tasks that are left'
      : 'Every block for today has been run';
    el.agendaProgress.hidden = true;
    el.agendaBar.style.transform = 'scaleX(0)';
    agendaLive = null;
  } else {
    el.agendaProgress.hidden = true;
    el.agendaBar.style.transform = 'scaleX(0)';
    agendaLive = null;
  }

  // ── the work column ──
  el.agendaWork.hidden = !hasWork;
  el.agendaBody.dataset.single = (!showSession || !hasWork) ? 'true' : 'false';

  el.agendaTasks.innerHTML = '';
  if (tasks.length) {
    el.agendaWorkHead.hidden = false;
    el.agendaWorkHead.textContent = `Pending · ${tasks.length}`;
    for (const t of tasks.slice(0, 3)) el.agendaTasks.appendChild(agendaTaskRow(t, date));
  } else {
    el.agendaWorkHead.hidden = !subjects.length;
    el.agendaWorkHead.textContent = 'Subjects';
  }

  if (subjects.length) {
    el.agendaSubjects.hidden = false;
    el.agendaSubjects.textContent = subjects
      .slice(0, 4)
      .map(s => `${s.name} ${s.done}/${s.total}`)
      .join(' · ')
      + (subjects.length > 4 ? ` · +${subjects.length - 4}` : '');
    el.agendaSubjects.title = subjects.map(s => `${s.name} ${s.done}/${s.total}`).join('\n');
  } else {
    el.agendaSubjects.hidden = true;
    el.agendaSubjects.textContent = '';
    el.agendaSubjects.title = '';
  }

  // ── the way back in ──
  const live = T.status === 'running' || T.status === 'paused';
  const onThisBlock = live && block && T.sessionId && T.sessionId === block.id;
  el.agendaContinue.hidden = !block;
  el.agendaFoot.dataset.single = block ? 'false' : 'true';
  if (block) {
    el.agendaContinueText.textContent = onThisBlock
      ? (T.status === 'paused' ? 'Resume timetable' : 'Timetable running')
      : (live ? 'Switch to timetable' : 'Continue Timetable');
    el.agendaContinue.dataset.state = onThisBlock
      ? (T.status === 'paused' ? 'paused' : 'running')
      : 'ready';
  }
}

/** One task line in the card — checkable, so the clock can tick work off. */
function agendaTaskRow(task, date) {
  const row = document.createElement('li');
  row.className = 'agenda__task';

  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'taskcheck';
  check.setAttribute('aria-label', `Mark "${task.text}" as done`);
  check.setAttribute('aria-pressed', 'false');
  check.addEventListener('click', () => {
    // Re-read the plan: another tab, or the plan page, may have changed it.
    const plan = planFor(date);
    plan.tasks = (Array.isArray(plan.tasks) ? plan.tasks : [])
      .map(t => (t.id === task.id ? { ...t, done: true } : t));
    setPlan(state, date, plan);
    lastAgendaSig = '';
    renderAgenda();
    renderPlanPanel();
    uiClick();
  });

  const text = document.createElement('span');
  text.className = 'agenda__task-text';
  text.textContent = task.text;

  row.append(check, text);

  if (task.stage) {
    const stage = document.createElement('span');
    stage.className = 'agenda__task-stage';
    stage.textContent = task.stage;
    row.appendChild(stage);
  }

  return row;
}

/**
 * Paint the live parts of the card — the time left and the bar.
 *
 * Called from the render loop, so it does the smallest possible amount of
 * work: one string comparison and one transform.
 */
function updateAgendaClock() {
  if (!agendaLive || el.agenda.hidden) return;
  const mins = minutesOfDay(Date.now());
  const { current, startMin, endMin } = agendaLive;

  let when = agendaLive.range;
  if (current) {
    const left = Math.max(0, endMin - mins);
    when += ` · ${formatDuration(left * 60000)} left`;
  } else {
    const until = Math.max(0, startMin - mins);
    when += ` · in ${formatDuration(until * 60000)}`;
  }
  if (when !== agendaLive.lastWhen) {
    agendaLive.lastWhen = when;
    el.agendaWhen.textContent = when;
  }

  if (current) {
    const span = endMin - startMin;
    const pct = span > 0 ? clamp((mins - startMin) / span, 0, 1) : 0;
    el.agendaBar.style.transform = `scaleX(${pct.toFixed(4)})`;
  }
}

function clearTodayPlan() {
  const date = dateKey(Date.now());
  if (!planFor(date).blocks.length) {
    showToast('Nothing planned for today');
    return;
  }
  if (!window.confirm('Clear today’s plan?')) return;
  setPlan(state, date, { ...planFor(date), blocks: [], imported: null });
  renderPlanPanel();
  renderAgenda();
  showToast('Today’s plan cleared');
}

function startPlanLoop() {
  if (planTimerId) return;
  planTimerId = setInterval(planTick, 10000);
}

/* ═══════════════════════════════════════════════════════════
   Settings UI
   ═══════════════════════════════════════════════════════════ */

function bindToggle(id, key, onChange) {
  const input = $(id);
  if (!input) return;
  input.checked = !!state.settings[key];
  input.addEventListener('change', () => {
    state.settings[key] = input.checked;
    save(state);
    onChange?.(input.checked);
  });
}

function bindNumber(id, key, { min, max, onChange }) {
  const input = $(id);
  if (!input) return;
  input.value = state.settings[key];
  input.addEventListener('change', () => {
    let v = parseInt(input.value, 10);
    if (Number.isNaN(v)) v = DEFAULTS.settings[key];
    v = clamp(v, min, max);
    input.value = v;
    state.settings[key] = v;
    save(state);
    onChange?.(v);
  });
}

function renderPresetChips() {
  el.presetChips.innerHTML = '';
  const all = [...state.settings.presets, ...state.settings.customPresets];
  all.forEach(p => {
    const wrap = document.createElement('span');
    wrap.className = 'chip-wrap';

    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = p.label;
    chip.setAttribute('aria-pressed', String(state.settings.focusMin === p.focus && state.settings.breakMin === p.break));
    chip.addEventListener('click', () => {
      state.settings.focusMin = p.focus;
      state.settings.breakMin = p.break;
      $('setFocus').value = p.focus;
      $('setBreak').value = p.break;
      save(state);
      if (T.mode === 'timer' && T.status === 'idle') { T.target = p.focus * 60000; }
      renderPresetChips();
      render();
      uiClick();
    });

    if (p.custom) {
      // A real button, so the preset can also be removed from the keyboard.
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'chip__x';
      x.textContent = '×';
      x.title = 'Remove preset';
      x.setAttribute('aria-label', `Remove preset ${p.label}`);
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        state.settings.customPresets = state.settings.customPresets.filter(c => c.id !== p.id);
        save(state);
        renderPresetChips();
      });
      wrap.append(chip, x);
    } else {
      wrap.append(chip);
    }
    el.presetChips.appendChild(wrap);
  });
}

function renderQuickDurations() {
  el.durationPresets.innerHTML = '';
  QUICK_DURATIONS.forEach(m => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = `${m}m`;
    chip.addEventListener('click', () => {
      applyDuration(m);
    });
    el.durationPresets.appendChild(chip);
  });
}

function applyDuration(minutes) {
  const m = clamp(Math.round(minutes) || 0, 1, 600);
  const running = T.status === 'running' || T.status === 'paused';
  // A plan block owns its own length — the popover must not fight it.
  const ownsTarget = !!T.sessionId;
  const total = m * 60000;

  if (T.kind === 'break') {
    state.settings.breakMin = m;
    $('setBreak').value = m;
  } else {
    state.settings.focusMin = m;
    $('setFocus').value = m;
  }
  if (T.mode === 'timer' && !ownsTarget) T.target = total;

  if (running && !ownsTarget) {
    if (elapsedMs() >= total) {
      // The new length is already used up — end the run honestly and leave
      // the timer ready for the new one.
      stop();
      T.target = total;
      T.status = 'idle';
    } else {
      // The session keeps running; only its total length changes. Nothing
      // that was already studied is thrown away.
      persistRuntime();
      scheduleTimeout();
    }
  } else if (!running) {
    T.status = 'idle';
    T.accumulated = 0;
    T.startedAt = 0;
    clearRuntime();
  }

  save(state);
  renderPresetChips();
  render();
  updateControls();
  closePopover();
  uiClick();
}

function bindSettings() {
  // Timer
  bindNumber('setFocus', 'focusMin', { min: 1, max: 600, onChange: (v) => { if (T.mode === 'timer' && T.status === 'idle') T.target = v * 60000; renderPresetChips(); render(); } });
  bindNumber('setBreak', 'breakMin', { min: 1, max: 120, onChange: () => { renderPresetChips(); } });
  bindNumber('setLongBreak', 'longBreakMin', { min: 1, max: 120 });
  bindNumber('setInterval', 'longBreakEvery', { min: 2, max: 12 });
  bindNumber('setGoal', 'dailyGoalMin', { min: 0, max: 960, onChange: () => { stats = computeStats(state); render(); } });

  bindToggle('setAutoBreak', 'autoBreak');
  bindToggle('setAutoFocus', 'autoFocus');
  bindToggle('setSoundOnDone', 'soundOnDone');

  // Plan
  bindToggle('setAutoPlan', 'autoPlan', (on) => {
    if (on) {
      if (!todayPlan().blocks.length) {
        // Nothing to run yet — say so and leave the switch off.
        el.ttBanner.hidden = false;
        el.ttBanner.dataset.tone = 'warn';
        el.ttBanner.textContent = 'Plan your day first, then switch this on.';
        $('setAutoPlan').checked = false;
        state.settings.autoPlan = false;
        save(state);
        showToast('Plan your day first');
        return;
      }
      planTick();
    }
  });
  bindToggle('setRingOnBlockEnd', 'ringOnBlockEnd');

  el.ttPick.addEventListener('click', (e) => { e.stopPropagation(); el.ttFile.click(); });
  el.ttDrop.addEventListener('click', () => el.ttFile.click());
  el.ttDrop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.ttFile.click(); }
  });
  el.ttFile.addEventListener('change', async () => {
    const file = el.ttFile.files?.[0];
    el.ttFile.value = '';
    if (file) await importTimetable(file);
  });

  ['dragenter', 'dragover'].forEach(type => {
    el.ttDrop.addEventListener(type, (e) => {
      e.preventDefault();
      el.ttDrop.dataset.dragging = 'true';
    });
  });
  ['dragleave', 'drop'].forEach(type => {
    el.ttDrop.addEventListener(type, (e) => {
      e.preventDefault();
      el.ttDrop.dataset.dragging = 'false';
    });
  });
  el.ttDrop.addEventListener('drop', async (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) await importTimetable(file);
  });

  el.ttClear.addEventListener('click', clearTodayPlan);
  // “Continue Timetable” — the clock picks up the block that is due.
  el.ttContinue?.addEventListener('click', () => {
    continueTimetable(dateKey(Date.now()));
    closeDrawer();
  });

  // Sound
  bindToggle('setSoundEnabled', 'soundEnabled', (on) => {
    sound.setEnabled(on);
    if (on) sound.play('click');
  });
  const soundTheme = $('setSoundTheme');
  soundTheme.value = state.settings.soundTheme;
  soundTheme.addEventListener('change', () => {
    state.settings.soundTheme = soundTheme.value;
    sound.setTheme(soundTheme.value);
    save(state);
    sound.play('start');
  });

  const vol = $('setVolume');
  vol.value = state.settings.volume;
  const setVolFill = () => {
    vol.style.setProperty('--pct', `${vol.value}%`);
    $('volumeVal').textContent = `${vol.value}%`;
  };
  setVolFill();
  vol.addEventListener('input', () => {
    state.settings.volume = parseInt(vol.value, 10);
    sound.setVolume(state.settings.volume / 100);
    setVolFill();
  });
  vol.addEventListener('change', () => save(state));

  bindToggle('setTick', 'tickSound');
  bindToggle('setUiClicks', 'uiClicks');

  document.querySelectorAll('[data-test]').forEach(btn => {
    btn.addEventListener('click', () => {
      // A preview must not switch the master sound on behind the user's back.
      const wasEnabled = sound.enabled;
      sound.setEnabled(true);
      sound.play(btn.dataset.test);
      sound.setEnabled(wasEnabled);
    });
  });

  // Display
  bindToggle('setMillis', 'showMillis', () => { lastTimeText = ''; render(); });
  bindToggle('setRingGlow', 'ringGlow', () => applyAppearance());
  bindToggle('setReduceMotion', 'reduceMotion', () => applyAppearance());
  bindToggle('setClock24', 'clock24', () => {
    // The clock format is used by the history, the plan and the home line.
    renderStats();
    renderPlanPanel();
    renderAgenda();
    render();
  });
  bindToggle('setFocusMode', 'focusMode', () => applyAppearance());

  const theme = $('setTheme');
  if (theme) {
    theme.value = state.settings.theme;
    theme.addEventListener('change', () => {
      state.settings.theme = theme.value;
      applyTheme(theme.value);
      save(state);
      uiClick();
    });
  }

  // System
  bindToggle('setWakeLock', 'wakeLock', (on) => {
    if (on) {
      if (!('wakeLock' in navigator)) {
        showSystemBanner('This browser cannot keep the screen awake — the timer stays accurate regardless.', 'warn');
        return;
      }
      if (T.status === 'running') requestWakeLock();
    } else {
      releaseWakeLock();
    }
  });

  const notif = $('setNotifications');
  notif.checked = !!state.settings.notifications;
  notif.addEventListener('change', async () => {
    if (!notif.checked) {
      state.settings.notifications = false;
      save(state);
      updateNotificationHint();
      return;
    }
    if (!('Notification' in window)) {
      notif.checked = false;
      showSystemBanner('Notifications are not supported in this browser.', 'warn');
      return;
    }
    const perm = Notification.permission === 'granted'
      ? 'granted'
      : await Notification.requestPermission();
    if (perm === 'granted') {
      state.settings.notifications = true;
      save(state);
      showSystemBanner('Alerts are on — you will be notified even with the screen off.', 'ok');
    } else {
      notif.checked = false;
      state.settings.notifications = false;
      save(state);
      showSystemBanner('Notification permission was declined.', 'warn');
    }
    updateNotificationHint();
  });

  $('resetSettings').addEventListener('click', () => {
    const keepSessions = state.sessions;
    const keepPresets = state.settings.customPresets;
    const keepPlans = state.plans;
    const keepActivities = state.activities;
    const keepMode = T.mode;
    const keepTheme = state.settings.theme;
    state = structuredClone(DEFAULTS);
    state.sessions = keepSessions;
    state.settings.customPresets = keepPresets;
    state.plans = keepPlans;
    state.activities = keepActivities;
    state.settings.mode = keepMode;
    state.settings.theme = keepTheme;
    state.counters = { focus: 0, break: 0 };
    saveNow(state);
    sound.setTheme(state.settings.soundTheme);
    sound.setVolume(state.settings.volume / 100);
    sound.setEnabled(state.settings.soundEnabled);
    applyAppearance();
    syncModeUI();
    syncSettingsUI();
    renderPresetChips();
    stats = computeStats(state);
    render();
    renderStats();
    renderPlanPanel();
    showToast('Settings restored to defaults');
  });

  // Data
  $('exportBtn').addEventListener('click', exportData);
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', importData);
  $('clearData').addEventListener('click', async () => {
    const ok = window.confirm('Erase every session, every plan and all settings? This cannot be undone.');
    if (!ok) return;
    clearStore();
    state = structuredClone(DEFAULTS);
    clearTimeout(timeoutId);
    stopLoop();
    releaseWakeLock();
    clearRuntime();
    T.status = 'idle'; T.accumulated = 0; T.startedAt = 0;
    T.kind = 'focus'; T.subject = ''; T.sessionId = '';
    T.mode = state.settings.mode;
    T.target = state.settings.focusMin * 60000;
    sound.setTheme(state.settings.soundTheme);
    sound.setVolume(state.settings.volume / 100);
    sound.setEnabled(state.settings.soundEnabled);
    applyAppearance();
    syncModeUI();
    syncSettingsUI();
    renderPresetChips();
    stats = computeStats(state);
    render();
    renderStats();
    renderPlanPanel();
    renderToday();
    showToast('All data erased');
  });
}

function syncSettingsUI() {
  const s = state.settings;
  $('setFocus').value = s.focusMin;
  $('setBreak').value = s.breakMin;
  $('setLongBreak').value = s.longBreakMin;
  $('setInterval').value = s.longBreakEvery;
  $('setGoal').value = s.dailyGoalMin;
  $('setAutoBreak').checked = s.autoBreak;
  $('setAutoFocus').checked = s.autoFocus;
  $('setSoundOnDone').checked = s.soundOnDone;
  $('setSoundEnabled').checked = s.soundEnabled;
  $('setSoundTheme').value = s.soundTheme;
  $('setVolume').value = s.volume;
  $('setVolume').style.setProperty('--pct', `${s.volume}%`);
  $('volumeVal').textContent = `${s.volume}%`;
  $('setTick').checked = s.tickSound;
  $('setUiClicks').checked = s.uiClicks;
  $('setMillis').checked = s.showMillis;
  $('setRingGlow').checked = s.ringGlow;
  $('setReduceMotion').checked = s.reduceMotion;
  $('setClock24').checked = s.clock24;
  $('setWakeLock').checked = s.wakeLock;
  $('setNotifications').checked = s.notifications;
  $('setFocusMode').checked = s.focusMode;
  $('setAutoPlan').checked = s.autoPlan;
  $('setRingOnBlockEnd').checked = s.ringOnBlockEnd;
  const theme = $('setTheme');
  if (theme) theme.value = s.theme;
  updateNotificationHint();
}

function updateNotificationHint() {
  const hint = $('notifHint');
  if (!hint) return;
  if (!('Notification' in window)) {
    hint.textContent = 'Not supported in this browser';
    return;
  }
  if (Notification.permission === 'denied') {
    hint.textContent = 'Blocked in browser settings';
    return;
  }
  hint.textContent = 'Alerts even when the screen is off';
}

function showSystemBanner(text, tone = 'warn') {
  const b = $('systemBanner');
  if (!b) return;
  b.textContent = text;
  b.dataset.tone = tone;
  b.hidden = false;
}

/* ═══════════════════════════════════════════════════════════
   Stats & history
   ═══════════════════════════════════════════════════════════ */

function renderStats() {
  stats = computeStats(state);

  const cards = [
    { label: 'Today', value: formatDuration(stats.todayMs) },
    { label: 'This week', value: formatDuration(stats.weekMs) },
    { label: 'Streak', value: `${stats.streak}d` },
    { label: 'Sessions', value: String(stats.totalCount) },
  ];
  el.statGrid.innerHTML = '';
  cards.forEach(c => {
    const d = document.createElement('div');
    d.className = 'stat';
    d.innerHTML = `<div class="stat__value"></div><div class="stat__label"></div>`;
    d.querySelector('.stat__value').textContent = c.value;
    d.querySelector('.stat__label').textContent = c.label;
    el.statGrid.appendChild(d);
  });

  // Week chart
  el.weekChart.innerHTML = '';
  const max = Math.max(...stats.last7.map(d => d.ms), 1);
  stats.last7.forEach(d => {
    const col = document.createElement('div');
    col.className = 'chart__col';
    col.dataset.today = String(d.isToday);
    col.dataset.empty = String(d.ms === 0);
    col.title = `${formatDuration(d.ms)}`;
    const bar = document.createElement('div');
    bar.className = 'chart__bar';
    const pct = d.ms === 0 ? 2 : Math.max(8, Math.round((d.ms / max) * 100));
    bar.style.height = `${pct}%`;
    const lbl = document.createElement('div');
    lbl.className = 'chart__label';
    lbl.textContent = d.label;
    col.append(bar, lbl);
    el.weekChart.appendChild(col);
  });

  // Sessions
  const list = recentSessions(state, 60);
  el.sessionCount.textContent = state.sessions.length
    ? (state.sessions.length > list.length
        ? `· ${state.sessions.length} · showing last ${list.length}`
        : `· ${state.sessions.length}`)
    : '';
  el.sessionList.innerHTML = '';
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No sessions yet. Start the timer or add time manually.';
    el.sessionList.appendChild(empty);
    return;
  }

  list.forEach(s => {
    const row = document.createElement('div');
    row.className = 'session';

    const icon = document.createElement('div');
    icon.className = 'session__icon';
    icon.textContent = s.label ? s.label.trim().charAt(0).toUpperCase()
      : (s.source === 'manual' ? '+' : (s.source === 'break' ? 'B' : 'S'));

    const main = document.createElement('div');
    main.className = 'session__main';
    const title = document.createElement('div');
    title.className = 'session__title';
    title.textContent = s.label || (s.source === 'break' ? 'Break'
      : s.source === 'manual' ? 'Manual entry'
      : s.source === 'stopwatch' ? 'Stopwatch' : 'Focus session');
    const sub = document.createElement('div');
    sub.className = 'session__sub';
    sub.textContent = `${formatDay(s.start)} · ${formatClock(s.start)}`;
    main.append(title, sub);

    const dur = document.createElement('div');
    dur.className = 'session__dur';
    dur.textContent = formatDuration(s.durationMs);

    const del = document.createElement('button');
    del.className = 'session__del';
    del.type = 'button';
    del.title = 'Delete';
    del.setAttribute('aria-label', 'Delete session');
    del.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    del.addEventListener('click', () => {
      removeSession(state, s.id);
      stats = computeStats(state);
      renderStats();
      renderToday();
      render();
      uiClick();
    });

    row.append(icon, main, dur, del);
    el.sessionList.appendChild(row);
  });
}

function exportData() {
  const payload = JSON.stringify({ exportedAt: new Date().toISOString(), ...state }, null, 2);
  const blob = new Blob([payload], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `cadence-${isoDateInput(Date.now())}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  showToast('Exported your data');
}

function importData(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  if (!window.confirm('Import this file? It will replace all Cadence data on this device (sessions, plans, settings).')) {
    event.target.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onerror = () => {
    showToast('That file could not be read');
    event.target.value = '';
  };
  reader.onload = () => {
    try {
      const parsed = JSON.parse(String(reader.result));
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.sessions)) {
        throw new Error('bad file');
      }
      // Every value from an arbitrary file is checked before it is trusted.
      state.settings = sanitizeSettings(parsed.settings);
      state.sessions = sanitizeSessions(parsed.sessions);
      state.counters = {
        focus: Number(parsed.counters?.focus) || 0,
        break: Number(parsed.counters?.break) || 0,
      };
      state.plans = sanitizePlans(parsed.plans);
      state.activities = sanitizeActivities(parsed.activities);
      if (Array.isArray(parsed.saved)) state.saved = sanitizeSavedPlans(parsed.saved);
      state.settings.mode = T.mode;
      saveNow(state);
      sound.setTheme(state.settings.soundTheme);
      sound.setVolume(state.settings.volume / 100);
      sound.setEnabled(state.settings.soundEnabled);
      applyAppearance();
      syncModeUI();
      syncSettingsUI();
      renderPresetChips();
      stats = computeStats(state);
      render();
      renderStats();
      renderPlanPanel();
      renderToday();
      showToast('Data imported');
    } catch {
      showToast('That file could not be read');
    } finally {
      event.target.value = '';
    }
  };
  reader.readAsText(file);
}

/* ═══════════════════════════════════════════════════════════
   UI surfaces: drawer, popover, dialog, toast
   ═══════════════════════════════════════════════════════════ */

function openDrawer() {
  // A pending hide from a previous close must not take this drawer down.
  clearTimeout(drawerHideTimer);
  drawerHideTimer = null;
  el.scrim.hidden = false;
  el.settingsPanel.hidden = false;
  requestAnimationFrame(() => {
    el.scrim.dataset.show = 'true';
    el.settingsPanel.dataset.show = 'true';
  });
  el.settingsBtn.setAttribute('aria-expanded', 'true');
  lastFocusTarget = document.activeElement;
  el.closeSettings.focus();
  renderStats();
  document.addEventListener('keydown', trapFocus, true);
}

function closeDrawer() {
  clearTimeout(drawerHideTimer);
  el.scrim.dataset.show = 'false';
  el.settingsPanel.dataset.show = 'false';
  el.settingsBtn.setAttribute('aria-expanded', 'false');
  document.removeEventListener('keydown', trapFocus, true);
  drawerHideTimer = setTimeout(() => {
    drawerHideTimer = null;
    el.scrim.hidden = true;
    el.settingsPanel.hidden = true;
  }, 420);
  lastFocusTarget?.focus?.();
}

function trapFocus(e) {
  if (e.key !== 'Tab' || el.settingsPanel.hidden) return;
  const nodes = el.settingsPanel.querySelectorAll(
    'button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])'
  );
  const list = [...nodes].filter(n => !n.disabled && n.offsetParent !== null);
  if (!list.length) return;
  const first = list[0];
  const last = list[list.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

function switchTab(name) {
  el.drawerTabs.forEach(t => {
    const on = t.dataset.tab === name;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;   // roving tabindex: one tab stop for the tablist
  });
  el.panels.forEach(p => { p.hidden = p.dataset.panel !== name; });
  if (name === 'data') renderStats();
  if (name === 'plan') renderPlanPanel();
}

function openPopover() {
  if (T.mode !== 'timer') return;
  if (T.sessionId) return;              // a plan block owns its length
  if (!el.settingsPanel.hidden) closeDrawer();
  popoverReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  el.durationInput.value = Math.max(1, Math.round(T.target / 60000));
  el.durationPop.hidden = false;
  positionPopover();
  el.durationInput.focus();
  el.durationInput.select();
}

function positionPopover() {
  const r = el.metaLabel.getBoundingClientRect();
  const w = el.durationPop.offsetWidth;
  const h = el.durationPop.offsetHeight;
  let left = r.left + r.width / 2 - w / 2;
  left = clamp(left, 16, window.innerWidth - w - 16);
  let top = r.bottom + 12;
  if (top + h > window.innerHeight - 16) top = Math.max(16, r.top - h - 12);
  el.durationPop.style.left = `${left}px`;
  el.durationPop.style.top = `${top}px`;
}

function closePopover() {
  if (el.durationPop.hidden) return;
  el.durationPop.hidden = true;
  // A role=dialog that keeps focus owes the page focus back.
  popoverReturnFocus?.focus?.();
  popoverReturnFocus = null;
}

function openAddDialog() {
  closePopover();
  if (!el.settingsPanel.hidden) closeDrawer();
  el.addHours.value = '0';
  el.addMinutes.value = '30';
  el.addLabel.value = '';
  el.addDate.value = isoDateInput(Date.now());
  if (typeof el.addDialog.showModal === 'function') el.addDialog.showModal();
  else el.addDialog.setAttribute('open', '');
  setTimeout(() => el.addMinutes.focus(), 60);
}

function submitAdd() {
  const h = clamp(parseInt(el.addHours.value, 10) || 0, 0, 24);
  const m = clamp(parseInt(el.addMinutes.value, 10) || 0, 0, 59);
  const ms = (h * 60 + m) * 60000;
  if (ms <= 0) { showToast('Enter how much time you studied'); return; }

  const dateVal = el.addDate.value || isoDateInput(Date.now());
  const isToday = dateVal === isoDateInput(Date.now());
  const start = isToday
    ? Date.now()
    : new Date(`${dateVal}T12:00:00`).getTime();

  addSession(state, {
    durationMs: ms,
    mode: 'manual',
    label: el.addLabel.value.trim(),
    source: 'manual',
    start,
  });

  stats = computeStats(state);
  renderToday();
  renderStats();
  render();
  el.addDialog.close?.();
  showToast(`Added ${formatDuration(ms)}`);
  uiClick();
}

/**
 * Toasts are queued, not overwritten.
 *
 * A session ending can fire two messages in the same breath — “Self study
 * session ended, 12:30 PM” and then “Break started” — and the second one must
 * not swallow the first. Each message gets its moment on screen.
 */
const toastQueue = [];
let toastBusy = false;

function showToast(message) {
  if (!message) return;
  toastQueue.push(message);
  while (toastQueue.length > 4) toastQueue.shift();
  if (!toastBusy) nextToast();
}

function nextToast() {
  clearTimeout(toastTimer);
  const message = toastQueue.shift();
  if (message === undefined) { toastBusy = false; return; }
  toastBusy = true;
  el.toast.textContent = message;
  el.toast.hidden = false;
  el.toast.dataset.leaving = 'false';
  toastTimer = setTimeout(() => {
    el.toast.dataset.leaving = 'true';
    setTimeout(() => {
      el.toast.hidden = true;
      nextToast();
    }, 260);
  }, 2400);
}

function uiClick() {
  if (state.settings.uiClicks && state.settings.soundEnabled) sound.play('click');
}

/* ═══════════════════════════════════════════════════════════
   Events
   ═══════════════════════════════════════════════════════════ */

function bindEvents() {
  el.tabs.forEach(tab => tab.addEventListener('click', () => { setMode(tab.dataset.mode); uiClick(); }));

  el.primaryBtn.addEventListener('click', () => {
    if (T.status === 'running') pause(); else start();
  });
  el.stopBtn.addEventListener('click', () => stop());
  el.resetBtn.addEventListener('click', () => { reset(); uiClick(); });
  $('addTimeBtn').addEventListener('click', () => { openAddDialog(); uiClick(); });

  el.metaLabel.addEventListener('click', () => {
    if (el.metaLabel.dataset.interactive === 'true') openPopover();
  });

  // The quiet way back into the timetable, right on the clock.
  el.agendaContinue.addEventListener('click', () => {
    continueTimetable(dateKey(Date.now()));
    uiClick();
  });

  // Popover
  el.durationClose.addEventListener('click', closePopover);
  el.durationApply.addEventListener('click', () => applyDuration(parseInt(el.durationInput.value, 10)));
  el.durationInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); applyDuration(parseInt(el.durationInput.value, 10)); }
  });

  // Drawer
  el.settingsBtn.addEventListener('click', () => { openDrawer(); uiClick(); });
  el.closeSettings.addEventListener('click', closeDrawer);
  el.scrim.addEventListener('click', closeDrawer);
  el.drawerTabs.forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  // A tablist promises arrow keys: the tabs walk with Left/Right and
  // Home/End, activating as they go, and only the chosen one holds the tab.
  document.querySelector('.drawer__tabs')?.addEventListener('keydown', (e) => {
    const i = el.drawerTabs.indexOf(document.activeElement);
    if (i < 0) return;
    let n = null;
    if (e.key === 'ArrowRight') n = (i + 1) % el.drawerTabs.length;
    else if (e.key === 'ArrowLeft') n = (i - 1 + el.drawerTabs.length) % el.drawerTabs.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = el.drawerTabs.length - 1;
    if (n === null) return;
    e.preventDefault();
    switchTab(el.drawerTabs[n].dataset.tab);
    el.drawerTabs[n].focus();
  });

  // Normalize the roving tabindex on load: the markup marks Timer as the
  // selected tab but leaves every one of them stoppable until a first switch.
  const initialTab = el.drawerTabs.find(t => t.getAttribute('aria-selected') === 'true') || el.drawerTabs[0];
  if (initialTab) switchTab(initialTab.dataset.tab);

  // Add dialog
  el.addSubmit.addEventListener('click', submitAdd);
  el.addCancel.addEventListener('click', () => el.addDialog.close?.());
  el.addClose.addEventListener('click', () => el.addDialog.close?.());
  // Enter inside the form adds the time instead of quietly closing the dialog.
  el.addForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    submitAdd();
  });

  // Import from the planner itself
  el.planImport?.addEventListener('click', () => el.planImportFile?.click());
  el.planImportFile?.addEventListener('change', async () => {
    const file = el.planImportFile.files?.[0];
    el.planImportFile.value = '';
    if (file) await importTimetable(file);
  });

  // Custom preset creator
  el.addPreset.addEventListener('click', () => {
    const existing = $('presetAdder');
    if (existing) { existing.remove(); return; }
    const row = document.createElement('div');
    row.id = 'presetAdder';
    row.className = 'row';
    row.style.marginTop = '10px';
    row.innerHTML = `
      <label class="field"><span class="field__label">Focus <em>min</em></span>
        <input class="input input--num" id="npFocus" type="number" min="1" max="600" value="${state.settings.focusMin}" inputmode="numeric"></label>
      <label class="field"><span class="field__label">Break <em>min</em></span>
        <input class="input input--num" id="npBreak" type="number" min="1" max="120" value="${state.settings.breakMin}" inputmode="numeric"></label>`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn--soft btn--sm';
    btn.textContent = 'Add';
    btn.style.marginBottom = '12px';
    btn.addEventListener('click', () => {
      const f = clamp(parseInt($('npFocus').value, 10) || 25, 1, 600);
      const b = clamp(parseInt($('npBreak').value, 10) || 5, 1, 120);
      state.settings.customPresets.push({ id: uid('p'), label: `${f} / ${b}`, focus: f, break: b, custom: true });
      save(state);
      renderPresetChips();
      row.remove();
      showToast('Preset added');
    });
    row.appendChild(btn);
    el.presetChips.parentElement.appendChild(row);
    $('npFocus').focus();
  });

  // Click outside popover
  document.addEventListener('pointerdown', (e) => {
    if (el.durationPop.hidden) return;
    if (!el.durationPop.contains(e.target) && !el.metaLabel.contains(e.target)) closePopover();
  });
  window.addEventListener('resize', () => { if (!el.durationPop.hidden) positionPopover(); });

  // Keyboard
  document.addEventListener('keydown', onKeyDown);

  // Lifecycle
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      sound.resume();
      if (T.status === 'running') {
        requestWakeLock();
        if (T.mode === 'timer') {
          const remaining = T.target - elapsedMs();
          if (remaining <= 0) finishSession(T.kind, Math.min(elapsedMs(), T.target));
          else scheduleTimeout();
        }
        startLoop();
      }
      planTick();
      render();
    } else {
      releaseWakeLock();
      // The clock keeps running in the background — but the time it has banked
      // is written to the disk before the tab goes away.
      syncLiveSession(true);
    }
  });

  window.addEventListener('pageshow', () => {
    if (T.status === 'running') startLoop();
    planTick();
  });
  window.addEventListener('pagehide', () => {
    persistRuntime();
    syncLiveSession(true);
    // The session writes are debounced — a tab closed within 120 ms of a
    // change must not lose it. Scoped write: everything else stays as the
    // disk already holds it.
    saveKeysNow(state, ['sessions', 'counters']);
  });

  // Install prompt
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    $('installBtn').hidden = false;
  });
  $('installBtn').addEventListener('click', async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    const res = await deferredInstall.userChoice;
    if (res.outcome === 'accepted') $('installBtn').hidden = true;
    deferredInstall = null;
  });
  window.addEventListener('appinstalled', () => {
    $('installBtn').hidden = true;
    showToast('Cadence installed');
  });
}

/* ── keyboard ────────────────────────────────────────────── */

function onKeyDown(e) {
  // Modifier combos belong to the browser (Ctrl+C, Ctrl+R, Ctrl+P, Cmd+Tab…).
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = (e.target.tagName || '').toLowerCase();
  const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
  // A focused button keeps its own Space activation.
  const onButton = tag === 'button' || tag === 'a';

  if (e.key === 'Escape') {
    if (!el.durationPop.hidden) { closePopover(); return; }
    if (!el.settingsPanel.hidden) { closeDrawer(); return; }
    if (el.addDialog.open) { el.addDialog.close(); return; }
    if (state.settings.focusMode) {
      state.settings.focusMode = false;
      save(state);
      applyAppearance();
      syncSettingsUI();
      return;
    }
    return;
  }

  // The duration popover is a modal dialog: Tab stays inside it.
  if (!el.durationPop.hidden && e.key === 'Tab') {
    const nodes = [...el.durationPop.querySelectorAll('button, input, select, [href], [tabindex]:not([tabindex="-1"])')]
      .filter(n => !n.disabled && n.offsetParent !== null);
    if (nodes.length) {
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    return;
  }

  // A dialog (or anything focused inside one) silences the shortcuts too —
  // a stray P must never walk the tab away from a decision the user is
  // in the middle of making.
  if (e.target.closest?.('dialog, [role="dialog"]')) return;

  if (typing || el.addDialog.open) return;
  // While the drawer is open only Escape does anything — the shortcuts must
  // never fire behind an open panel.
  if (!el.settingsPanel.hidden) return;

  if (e.code === 'Space') {
    if (onButton) return;
    e.preventDefault();
    if (T.status === 'running') pause(); else start();
  } else if (e.key === 'r' || e.key === 'R') {
    reset();
  } else if (e.key === 's' || e.key === 'S') {
    setMode(T.mode === 'timer' ? 'stopwatch' : 'timer');
  } else if (e.key === 'c' || e.key === 'C') {
    continueTimetable(dateKey(Date.now()));
  } else if (e.key === 'a' || e.key === 'A') {
    openAddDialog();
  } else if (e.key === 'f' || e.key === 'F') {
    state.settings.focusMode = !state.settings.focusMode;
    save(state);
    applyAppearance();
    syncSettingsUI();
  } else if (e.key === 'p' || e.key === 'P') {
    // The planner lives on its own page now.
    location.href = './plan.html';
  }
}

/* ═══════════════════════════════════════════════════════════
   PWA bootstrap
   ═══════════════════════════════════════════════════════════ */

/* The service worker is registered by assets/js/swreg.js on every page, so
   the landing and the planner warm it up too — and the "Update ready" toast
   there now carries a Reload button instead of telling the person to reopen
   the app (a force-kill on iOS). */

function detectPlatform() {
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (iOS && !standalone) $('iosHint').hidden = false;
  if (!('wakeLock' in navigator)) {
    $('wakeLockHint').textContent = 'Not supported by this browser — timing stays exact regardless';
  } else if (iOS) {
    $('wakeLockHint').textContent = 'iOS only holds a wake lock on Home Screen apps running iOS 18.4+';
  }
  if (!('Notification' in window)) {
    $('notifHint').textContent = 'Not supported by this browser';
  }
}

/**
 * Launch parameters — used by the PWA shortcuts in the manifest.
 *
 * The old `?view=plan` shortcut is still honoured: it simply walks over to
 * the plan page, which is where the planner lives now.
 */
function applyLaunchParams() {
  const params = new URLSearchParams(location.search);
  const view = params.get('view');
  const mode = params.get('mode');
  const dur = parseInt(params.get('dur'), 10);

  if (view === 'plan') {
    location.replace('./plan.html');
    return;
  }

  if (mode === 'timer' || mode === 'stopwatch') {
    T.mode = mode;
    state.settings.mode = mode;
    syncModeUI();
  }

  if (mode === 'timer' && dur >= 1 && dur <= 600 && T.status === 'idle') {
    // A shortcut starts one session of the requested length — it never
    // overwrites the session length the user chose for themselves.
    T.kind = 'focus';
    T.target = dur * 60000;
    setTimeout(() => { if (T.status === 'idle') start({ target: dur * 60000 }); }, 80);
  }
}

/* ═══════════════════════════════════════════════════════════
   Init
   ═══════════════════════════════════════════════════════════ */

function init() {
  // The mode the user last used is the mode they get back.
  T.mode = state.settings.mode === 'timer' ? 'timer' : 'stopwatch';
  T.target = state.settings.focusMin * 60000;

  const version = $('appVersion');
  if (version) version.textContent = APP_VERSION;

  sound.setTheme(state.settings.soundTheme);
  sound.setVolume(state.settings.volume / 100);
  sound.setEnabled(state.settings.soundEnabled);

  applyAppearance();
  syncModeUI();
  syncSettingsUI();
  renderPresetChips();
  renderQuickDurations();

  // The planner lives on its own page now — this page is the clock.
  stats = computeStats(state);
  render();
  renderToday();
  renderStats();
  renderPlanPanel();

  bindEvents();
  bindSettings();
  restoreRuntime();
  // Any session that was still live when the app went away is closed here —
  // the time it banked is real, so it is kept.
  closeOrphanSessions(state, Date.now(), liveSessionId);
  applyLaunchParams();
  updateControls();
  render();

  detectPlatform();
  startPlanLoop();
  planTick();

  // The store moved underneath us — the plan page painted or copied a day in
  // another tab. Re-read it; the rendering loop picks the new state up on its
  // next tick, and the redraws here make idle moments feel instant. The live
  // timer is untouched — it lives in memory and runtime.js.
  window.addEventListener('cadence:store-external', () => {
    state = load();
    stats = computeStats(state);
    renderStats();
    renderToday();
    renderPlanPanel();
  });

  // The store fell back to defaults somewhere — say so; there is a backup
  // under cadence.store.v1.bad and the person deserves to know. The notice
  // can also arrive as an event after this init — both paths show it once,
  // because a good load clears the notice.
  const corrupt = storeErrorNotice();
  if (corrupt) showToast(corrupt);
  window.addEventListener('cadence:store-corrupt', (e) => {
    showToast(e.detail?.message || 'Saved data could not be read — a backup was kept');
  });

  // iOS never reflows a fixed container for the keyboard, so an input near
  // its bottom can hide behind it. Bring the focused field to view — the
  // scrollable ancestor (drawer body, popover) is what actually moves.
  window.addEventListener('focusin', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement) || !t.matches('input, select, textarea')) return;
    if (!t.closest('.drawer, .popover')) return;
    setTimeout(() => t.scrollIntoView({ block: 'center', behavior: 'smooth' }), 350);
  });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      const t = document.activeElement;
      if (t instanceof HTMLElement && t.matches('input, select, textarea') && t.closest('.drawer, .popover')) {
        t.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    });
  }

  // First interaction unlocks audio on browsers that require a gesture.
  const unlock = () => { sound.unlock(); window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
