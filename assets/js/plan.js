/**
 * Cadence — the plan model.
 *
 * A *plan* is what a day is supposed to look like: a list of blocks
 * ("Self study 10:00 – 12:30", "Lunch 12:30 – 13:00") and a list of tasks.
 *
 * The planner writes plans, the clock reads them. That is the whole idea of
 * this app: the same structure that paints the day is the structure the timer
 * runs, so there is only ever one truth about what today looks like.
 *
 * Blocks are stored in minutes past local midnight on the plan's own date.
 * The grid paints in 15-minute slots, so a block usually lands on a slot
 * boundary — but the model does not insist on it, and an imported timetable
 * keeps its exact times.
 */

import { uid, clockLabel } from './util.js';

export const SLOT_MIN = 30;          // one grid slot = 30 minutes (like TestOnGo)
export const SLOTS = 48;             // 24 hours × 2
export const DAY_MIN = 1440;

const BREAK_RE = /\b(break|sleep|rest|lunch|meal|dinner|recess|nap|tea|free)\b/i;

/* ── activities ───────────────────────────────────────────── */

/**
 * The palette is deliberately wordless: there are no colours in this app, so
 * an activity is told apart by its name, its kind and a stable grey tone.
 */
export const ACTIVITIES = [
  { key: 'sleep',      label: 'Sleep',      kind: 'rest' },
  { key: 'school',     label: 'School',     kind: 'life' },
  { key: 'coaching',   label: 'Coaching',   kind: 'life' },
  { key: 'self_study', label: 'Self study', kind: 'study' },
  { key: 'physics',    label: 'Physics',    kind: 'study' },
  { key: 'chemistry',  label: 'Chemistry',  kind: 'study' },
  { key: 'maths',      label: 'Maths',      kind: 'study' },
  { key: 'biology',    label: 'Biology',    kind: 'study' },
  { key: 'revision',   label: 'Revision',   kind: 'study' },
  { key: 'test',       label: 'Test',       kind: 'study' },
  { key: 'breaks',     label: 'Breaks',     kind: 'rest' },
  { key: 'misc',       label: 'Misc',       kind: 'life' },
];

/** Every activity, built-ins first, then the user's own. */
export function activityMap(custom = []) {
  const map = new Map();
  for (const a of ACTIVITIES) map.set(a.key, { ...a });
  for (const a of custom) {
    if (a && typeof a.key === 'string' && a.key) {
      map.set(a.key, {
        key: a.key,
        label: String(a.label || a.key).slice(0, 40),
        kind: a.kind === 'study' || a.kind === 'rest' || a.kind === 'life' ? a.kind : 'study',
      });
    }
  }
  return map;
}

/** A stable grey tone for an activity — the only way to tell two apart. */
export function toneOf(key) {
  let h = 0;
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return h % 5;
}

/** The single letter shown in the grid when a block is too small for a word. */
export function codeOf(label) {
  const words = String(label).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '·';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return words.map(w => w[0]).join('').slice(0, 2).toUpperCase();
}

/* ── plans ────────────────────────────────────────────────── */

export function emptyPlan(date) {
  return { date, blocks: [], tasks: [], imported: null, done: {}, updatedAt: 0 };
}

export function blockDurationMs(block) {
  return Math.max(0, (block.endMin - block.startMin)) * 60000;
}

/** Blocks in the order they happen. */
export function sortBlocks(blocks) {
  return blocks.slice().sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
}

/** Fold touching blocks that share a key into one. */
export function mergeBlocks(blocks) {
  const out = [];
  for (const b of sortBlocks(blocks)) {
    const prev = out[out.length - 1];
    if (prev && prev.key === b.key && prev.endMin === b.startMin) {
      prev.endMin = b.endMin;
      continue;
    }
    out.push({ ...b });
  }
  return out;
}

/**
 * Paint one slot of the grid.
 *
 * @param {Array}  blocks   current blocks
 * @param {number} slot     0 … 95
 * @param {object|null} activity  the activity to paint, or null to erase
 * @returns {Array} a new list of blocks
 */
export function paintSlot(blocks, slot, activity) {
  const start = slot * SLOT_MIN;
  const end = start + SLOT_MIN;

  const out = [];
  for (const b of blocks) {
    if (b.endMin <= start || b.startMin >= end) { out.push(b); continue; }
    if (b.startMin < start) out.push({ ...b, endMin: start });
    if (b.endMin > end) out.push({ ...b, id: uid('b'), startMin: end });
  }

  if (activity) {
    let s = start;
    let e = end;

    // Grow into the neighbours when they are the same activity.
    const prev = out[out.length - 1];
    if (prev && prev.key === activity.key && prev.endMin === s) {
      s = prev.startMin;
      out.pop();
    }
    const nextAt = out.findIndex(b => b.startMin === e);
    if (nextAt >= 0 && out[nextAt].key === activity.key) {
      e = out[nextAt].endMin;
      out.splice(nextAt, 1);
    }

    out.push({
      id: uid('b'),
      key: activity.key,
      label: activity.label,
      kind: activity.kind,
      startMin: s,
      endMin: e,
    });
  }

  return mergeBlocks(out);
}

/** Remove a whole block. */
export function removeBlock(blocks, id) {
  return blocks.filter(b => b.id !== id);
}

/** The block covering a given minute of the day, if any. */
export function blockAt(blocks, minutes) {
  for (const b of sortBlocks(blocks)) {
    if (minutes >= b.startMin && minutes < b.endMin) return b;
  }
  return null;
}

/** The first block that has not started yet. */
export function nextBlock(blocks, minutes) {
  for (const b of sortBlocks(blocks)) {
    if (b.startMin > minutes) return b;
  }
  return null;
}

/**
 * What the day looks like right now.
 *
 * `current` is the block that is running at this minute of the day — the
 * thing the person is supposed to be doing. `next` is the one after it.
 * On a day that is not today there is no “now”, so the current block is null
 * and the next one is simply the first block of that day.
 */
export function dayProgress(blocks, minutes, isToday = true) {
  const sorted = sortBlocks(blocks);
  if (!sorted.length) return { current: null, next: null };
  if (!isToday) return { current: null, next: sorted[0] };
  return { current: blockAt(sorted, minutes), next: nextBlock(sorted, minutes) };
}

/**
 * The work that is still to be done on a day.
 *
 * A timetable carries two kinds of to-do: the tasks the person typed, and
 * the subject breakdown that came with an imported timetable. Both are
 * returned so the planner can show them side by side.
 */
export function pendingWork(plan) {
  const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
  const subjects = Array.isArray(plan?.imported?.subjects) ? plan.imported.subjects : [];
  return {
    tasks,
    subjects,
    left: tasks.filter(t => !t.done).length,
    total: tasks.length,
  };
}

/** Everything the header of the planner wants to say about a day. */
export function planSummary(plan) {
  const blocks = plan ? plan.blocks : [];
  let study = 0;
  let rest = 0;
  let life = 0;
  for (const b of blocks) {
    const mins = b.endMin - b.startMin;
    if (b.kind === 'study') study += mins;
    else if (b.kind === 'rest') rest += mins;
    else life += mins;
  }
  const tasks = plan && Array.isArray(plan.tasks) ? plan.tasks : [];
  return {
    blocks: blocks.length,
    studyMin: study,
    restMin: rest,
    lifeMin: life,
    plannedMin: study + rest + life,
    freeMin: Math.max(0, DAY_MIN - study - rest - life),
    tasks: tasks.length,
    tasksDone: tasks.filter(t => t.done).length,
  };
}

/* ── sanitising ───────────────────────────────────────────── */

function sanitizeBlock(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const startMin = Math.round(Number(raw.startMin));
  const endMin = Math.round(Number(raw.endMin));
  if (!Number.isFinite(startMin) || !Number.isFinite(endMin)) return null;
  if (startMin < 0 || endMin > DAY_MIN || endMin <= startMin) return null;
  const key = typeof raw.key === 'string' && raw.key ? raw.key.slice(0, 60) : null;
  if (!key) return null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : uid('b'),
    key,
    label: typeof raw.label === 'string' && raw.label.trim()
      ? raw.label.trim().slice(0, 40)
      : key,
    kind: raw.kind === 'study' || raw.kind === 'rest' || raw.kind === 'life' ? raw.kind : 'study',
    startMin,
    endMin,
  };
}

function sanitizeTask(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = typeof raw.text === 'string' ? raw.text.trim().slice(0, 120) : '';
  if (!text) return null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : uid('t'),
    text,
    stage: typeof raw.stage === 'string' ? raw.stage.slice(0, 24) : '',
    done: !!raw.done,
    createdAt: Number(raw.createdAt) || Date.now(),
  };
}

/** Rebuild a plan from disk or from an imported file. */
export function sanitizePlan(raw, date) {
  const plan = emptyPlan(date);
  if (!raw || typeof raw !== 'object') return plan;

  if (Array.isArray(raw.blocks)) {
    plan.blocks = mergeBlocks(raw.blocks.map(sanitizeBlock).filter(Boolean));
  }
  if (Array.isArray(raw.tasks)) {
    plan.tasks = raw.tasks.map(sanitizeTask).filter(Boolean);
  }
  if (raw.imported && typeof raw.imported === 'object') {
    const label = typeof raw.imported.label === 'string' ? raw.imported.label.slice(0, 80) : '';
    const subjects = Array.isArray(raw.imported.subjects)
      ? raw.imported.subjects
          .filter(s => s && typeof s.name === 'string')
          .slice(0, 40)
          .map(s => ({ name: s.name.slice(0, 40), done: Number(s.done) || 0, total: Number(s.total) || 0 }))
      : [];
    plan.imported = { label, subjects };
  }
  // `done` remembers which blocks have already been dealt with, so the clock
  // never runs the same block twice.
  if (raw.done && typeof raw.done === 'object') {
    for (const [id, flag] of Object.entries(raw.done)) {
      if (typeof id === 'string' && flag) plan.done[id] = true;
    }
  }
  plan.updatedAt = Number(raw.updatedAt) || 0;
  return plan;
}

/* ── from a TestOnGo dashboard ────────────────────────────── */

/**
 * Turn parsed timetable sessions into blocks.
 *
 * Subjects are matched against the activity list; anything unknown becomes a
 * study block of its own so nothing is silently dropped.
 */
export function blocksFromSessions(sessions, custom = []) {
  const map = activityMap(custom);
  const blocks = [];

  for (const s of sessions) {
    const subject = String(s.subject || 'Session').trim() || 'Session';
    let activity = null;
    const lower = subject.toLowerCase();
    for (const a of map.values()) {
      if (a.label.toLowerCase() === lower) { activity = a; break; }
    }
    if (!activity) {
      for (const a of map.values()) {
        if (a.label.toLowerCase().includes(lower) || lower.includes(a.label.toLowerCase())) {
          activity = a;
          break;
        }
      }
    }
    if (!activity) {
      const key = `sub:${subject.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'session'}`;
      activity = {
        key,
        label: subject.slice(0, 40),
        kind: BREAK_RE.test(subject) ? 'rest' : 'study',
      };
    }

    let startMin = Math.max(0, Math.round(s.startMin));
    let endMin = Math.round(s.endMin);
    if (endMin > DAY_MIN) endMin = DAY_MIN;
    if (endMin <= startMin) continue;

    blocks.push({
      id: uid('b'),
      key: activity.key,
      label: activity.label,
      kind: activity.kind,
      startMin,
      endMin,
    });
  }

  return mergeBlocks(blocks);
}

/** The activities a set of blocks needs that the app does not know yet. */
export function customActivitiesFor(blocks, known = []) {
  const knownKeys = new Set([...ACTIVITIES.map(a => a.key), ...known.map(a => a.key)]);
  const out = [];
  const seen = new Set();
  for (const b of blocks) {
    if (knownKeys.has(b.key) || seen.has(b.key)) continue;
    seen.add(b.key);
    out.push({ key: b.key, label: b.label, kind: b.kind });
  }
  return out;
}

/** '10:00 AM – 12:30 PM' */
export function blockRangeLabel(block) {
  return `${clockLabel(block.startMin)} – ${clockLabel(block.endMin)}`;
}

/**
 * Adjust a block's length by dragging its edges (snapped to 30-minute grid).
 */
export function resizeBlock(blocks, blockId, direction, deltaMin) {
  if (!deltaMin) return blocks;
  const idx = blocks.findIndex(b => b.id === blockId);
  if (idx === -1) return blocks;
  const next = [...blocks];
  const b = { ...next[idx] };
  if (direction === 'start') {
    b.startMin = Math.max(0, Math.min(b.endMin - SLOT_MIN, b.startMin + deltaMin));
    b.startMin = Math.round(b.startMin / SLOT_MIN) * SLOT_MIN;
    b.startSlot = Math.floor(b.startMin / SLOT_MIN);
  } else {
    b.endMin = Math.max(b.startMin + SLOT_MIN, Math.min(DAY_MIN, b.endMin + deltaMin));
    b.endMin = Math.round(b.endMin / SLOT_MIN) * SLOT_MIN;
    b.endSlot = Math.floor(b.endMin / SLOT_MIN);
  }
  if (b.endMin <= b.startMin) return blocks.filter(x => x.id !== blockId);
  next[idx] = b;
  return mergeBlocks(next);
}
