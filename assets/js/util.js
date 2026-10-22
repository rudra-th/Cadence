/**
 * Cadence — shared helpers.
 *
 * Small, dependency-free utilities used by the store, the plan model and the
 * controller. Keeping them here means no module has to import another one
 * just for a date or an id.
 */

/* ── numbers ──────────────────────────────────────────────── */

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export const pad2 = (n) => String(n).padStart(2, '0');

/* ── ids ──────────────────────────────────────────────────── */

export function uid(prefix = 'b') {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/* ── dates ────────────────────────────────────────────────── */

/** 'YYYY-MM-DD' for a timestamp. */
export function dateKey(ts) {
  const d = new Date(ts);
  return dateKeyFromDate(d);
}

/** 'YYYY-MM-DD' for a Date. */
export function dateKeyFromDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** The timestamp of 00:00 local time on that day. */
export function startOfDayKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

/** Move a day key by n days. */
export function shiftKey(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + n);
  return dateKeyFromDate(date);
}

/** Human label for a day key. */
export function labelDate(key, opts = {}) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', opts);
}

/** Minutes past local midnight. */
export function minutesOfDay(ts = Date.now()) {
  const d = new Date(ts);
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

/** '9:30 AM' */
export function clockLabel(minutes) {
  const total = Math.max(0, Math.round(minutes));
  const h24 = Math.floor(total / 60) % 24;
  const m = total % 60;
  const ampm = h24 < 12 ? 'AM' : 'PM';
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}:${pad2(m)} ${ampm}`;
}

/** '2h 30m' / '45m' */
export function humanDuration(ms) {
  const total = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}
