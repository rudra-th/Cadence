/**
 * Cadence — the timer runtime.
 *
 * The plan and the clock are two different pages now, but they share one
 * timer. This module is the tiny post between them: it keeps the state of a
 * running session in localStorage so any page can pick it up, hand it over,
 * or leave it running.
 *
 * The runtime is deliberately small. It holds only what is needed to rebuild
 * a run:
 *
 *   mode        stopwatch | timer
 *   status      idle | running | paused
 *   kind        focus | break
 *   startedAt   wall-clock stamp of the moment the run began
 *   accumulated milliseconds banked by a pause
 *   target      the length of the run, in milliseconds
 *   subject     the name of the plan block being run
 *   sessionId   the id of that plan block
 *
 * Everything is derived from absolute timestamps, never from tick counts —
 * so a run that crosses a page change, a reload or a sleep still counts the
 * time it really spent.
 */

export const RUNTIME_KEY = 'cadence.runtime.v1';

/** Read the runtime, or null when there is nothing running. */
export function readRuntime() {
  try {
    const raw = localStorage.getItem(RUNTIME_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Write the runtime. Never throws — a private-mode browser just forgets. */
export function writeRuntime(rt) {
  try {
    localStorage.setItem(RUNTIME_KEY, JSON.stringify(rt));
  } catch {
    /* private mode / quota — the run still works, it just will not survive */
  }
}

/** Forget the runtime. */
export function clearRuntime() {
  try {
    localStorage.removeItem(RUNTIME_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Hand a block over to the clock page.
 *
 * The plan page calls this when the person presses “Continue Timetable” (or
 * “Start” on a block). The clock page picks the run up the moment it opens
 * and keeps counting from the timestamp written here — the seconds spent
 * choosing a block are seconds the timer already owns.
 *
 * @param {object}  opts
 * @param {string}  opts.subject   the name of the block
 * @param {string}  opts.sessionId the id of the block
 * @param {number}  opts.target    how long the run should last, in ms
 * @param {string}  [opts.kind]    focus (default) or break
 * @param {string}  [opts.date]    the day the block belongs to
 */
export function handOverToClock({ subject, sessionId, target, kind = 'focus', date = '' }) {
  writeRuntime({
    mode: 'timer',
    status: 'running',
    kind: kind === 'break' ? 'break' : 'focus',
    startedAt: Date.now(),
    accumulated: 0,
    target: Math.max(1000, Math.round(target || 0)),
    subject: String(subject || '').slice(0, 60),
    sessionId: String(sessionId || ''),
    date: String(date || ''),
  });
}

/**
 * Is a run alive right now?
 *
 * The plan page uses this to show a quiet “timer running” note, so the
 * person always knows the clock is still going.
 */
export function runningSession() {
  const rt = readRuntime();
  if (!rt) return null;
  if (rt.status !== 'running' && rt.status !== 'paused') return null;
  return rt;
}
