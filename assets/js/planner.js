/**
 * Cadence — the day planner.
 *
 * The planner is the half of the app that writes the day down: a 24-hour grid
 * you paint by dragging, the blocks that fall out of it, and the tasks that
 * belong to it. Everything it produces is stored as *blocks*, which is exactly
 * what the clock runs — so a plan made here is already a schedule the timer
 * can pick up.
 */

import {
  SLOT_MIN, SLOTS, activityMap, toneOf, codeOf,
  paintSlot, removeBlock, planSummary,
  blockRangeLabel, customActivitiesFor,
} from './plan.js';
import {
  dateKey, shiftKey, labelDate, clockLabel, humanDuration,
  minutesOfDay, uid,
} from './util.js';

const HALF = 48;                 // slots per column (12 hours)
const COL_MIN = 720;             // minutes per column

let ctx = null;
let currentDate = dateKey(Date.now());
let painting = false;
let eraseMode = false;

/* ── mounting ────────────────────────────────────────────── */

export function mountPlanner(context) {
  ctx = context;
  currentDate = dateKey(Date.now());
  bindEvents();
  renderPlanner();
}

/** The date the planner is showing. */
export function plannerDate() {
  return currentDate;
}

/** Show another day. */
export function setPlannerDate(date) {
  currentDate = date;
  renderPlanner();
}

/** Redraw everything (after a change somewhere else). */
export function refreshPlanner() {
  if (ctx) renderPlanner();
}

/* ── state helpers ───────────────────────────────────────── */

function plan() {
  return ctx.getPlan(currentDate);
}

function writePlan(next) {
  ctx.setPlan(currentDate, next);
  renderPlanner();
  ctx.onPlanChanged(currentDate);
}

function activities() {
  return activityMap(ctx.state.activities);
}

function brushActivity() {
  const map = activities();
  if (eraseMode) return null;
  const key = ctx.state.settings.brush;
  return map.get(key) || map.get('self_study') || { key: 'self_study', label: 'Self study', kind: 'study' };
}

/* ── rendering ───────────────────────────────────────────── */

export function renderPlanner() {
  if (!ctx) return;
  const p = plan();
  const summary = planSummary(p);

  // ── date header
  const today = dateKey(Date.now());
  const isToday = currentDate === today;
  ctx.el.planTitle.textContent = labelDate(currentDate, { weekday: 'long', day: 'numeric', month: 'long' });
  const bits = [];
  if (isToday) bits.push('Today');
  bits.push(`${summary.blocks} block${summary.blocks.length === 1 ? '' : 's'}`);
  if (summary.studyMin) bits.push(`${humanDuration(summary.studyMin * 60000)} study`);
  if (summary.freeMin) bits.push(`${humanDuration(summary.freeMin * 60000)} free`);
  if (summary.tasks) bits.push(`${summary.tasksDone}/${summary.tasks} tasks`);
  ctx.el.planSub.textContent = bits.join(' · ');

  // ── week strip
  renderWeekStrip();

  // ── grid
  renderGrid(p);

  // ── block list
  renderBlockList(p);

  // ── tasks
  renderTasks(p);

  // ── activity picker
  renderPicker();
}

function renderWeekStrip() {
  const strip = ctx.el.planWeek;
  strip.innerHTML = '';
  const today = dateKey(Date.now());
  for (let i = -3; i <= 3; i += 1) {
    const key = shiftKey(currentDate, i);
    const p = ctx.getPlan(key);
    const has = p.blocks.length > 0;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'weekday';
    if (key === currentDate) btn.setAttribute('aria-current', 'date');
    btn.dataset.has = has ? 'true' : 'false';
    btn.dataset.today = key === today ? 'true' : 'false';
    btn.title = labelDate(key, { weekday: 'long', day: 'numeric', month: 'long' });
    btn.innerHTML = `
      <span class="weekday__name">${labelDate(key, { weekday: 'short' })}</span>
      <span class="weekday__num">${key.slice(8)}</span>
      <span class="weekday__dot"></span>`;
    strip.appendChild(btn);
  }
}

function renderGrid(p) {
  const map = activities();

  for (const col of [0, 1]) {
    const track = ctx.el.planTracks[col];
    const gutter = ctx.el.planGutters[col];
    track.innerHTML = '';
    gutter.innerHTML = '';

    // hour labels
    for (let row = 0; row < HALF; row += 1) {
      const mins = col * COL_MIN + row * SLOT_MIN;
      const label = document.createElement('span');
      label.className = 'grid__hour';
      if (mins % 60 === 0) {
        label.textContent = clockLabel(mins).replace(':00', '');
        label.classList.add('is-hour');
      }
      gutter.appendChild(label);
    }

    // blocks
    for (const b of p.blocks) {
      const localStart = b.startMin - col * COL_MIN;
      const localEnd = b.endMin - col * COL_MIN;
      if (localEnd <= 0 || localStart >= COL_MIN) continue;

      const from = Math.max(0, localStart);
      const to = Math.min(COL_MIN, localEnd);
      const rowStart = Math.floor(from / SLOT_MIN);
      const rowEnd = Math.ceil(to / SLOT_MIN);
      if (rowEnd <= rowStart) continue;

      const act = map.get(b.key);
      const el = document.createElement('div');
      el.className = 'grid__block';
      el.dataset.key = b.key;
      el.dataset.tone = String(toneOf(b.key));
      el.dataset.kind = b.kind;
      el.style.setProperty('--row', String(rowStart));
      el.style.setProperty('--span', String(rowEnd - rowStart));
      el.title = `${b.label} · ${blockRangeLabel(b)}`;
      el.innerHTML = `<span class="grid__blocklabel">${escapeHtml(b.label)}</span>`
        + `<span class="grid__blockcode">${escapeHtml(codeOf(b.label))}</span>`;
      track.appendChild(el);
    }

    // the current time
    if (currentDate === dateKey(Date.now())) {
      const mins = minutesOfDay();
      const local = mins - col * COL_MIN;
      if (local >= 0 && local < COL_MIN) {
        const now = document.createElement('div');
        now.className = 'grid__now';
        now.style.setProperty('--row', String(local / SLOT_MIN));
        track.appendChild(now);
      }
    }
  }
}

function renderBlockList(p) {
  const list = ctx.el.planBlocks;
  list.innerHTML = '';
  if (!p.blocks.length) {
    list.innerHTML = '<p class="empty">Nothing planned yet. Pick an activity and drag across the grid.</p>';
    return;
  }
  for (const b of p.blocks) {    const row = document.createElement('div');
    row.className = 'blockrow';
    row.dataset.tone = String(toneOf(b.key));
    row.dataset.kind = b.kind;

    const main = document.createElement('div');
    main.className = 'blockrow__main';
    const title = document.createElement('span');
    title.className = 'blockrow__title';
    title.textContent = b.label;
    const sub = document.createElement('span');
    sub.className = 'blockrow__sub';
    sub.textContent = `${blockRangeLabel(b)} · ${humanDuration((b.endMin - b.startMin) * 60000)}`;
    main.append(title, sub);

    const actions = document.createElement('div');
    actions.className = 'blockrow__actions';
    const start = document.createElement('button');
    start.type = 'button';
    start.className = 'btn btn--soft btn--sm';
    start.textContent = 'Start';
    start.title = 'Run this block on the clock';
    start.addEventListener('click', () => ctx.onStartBlock(b));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'icon-btn icon-btn--sm';
    del.setAttribute('aria-label', `Remove ${b.label}`);
    del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" '
      + 'stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    del.addEventListener('click', () => {
      writePlan({ ...plan(), blocks: removeBlock(plan().blocks, b.id) });
    });
    actions.append(start, del);

    row.append(main, actions);
    list.appendChild(row);
  }
}

function renderTasks(p) {
  const list = ctx.el.planTasks;
  list.innerHTML = '';
  ctx.el.planTaskCount.textContent = p.tasks.length
    ? `· ${p.tasks.filter(t => t.done).length}/${p.tasks.length}`
    : '';

  if (!p.tasks.length) {
    list.innerHTML = '<p class="empty">No tasks for this day yet.</p>';
    return;
  }
  for (const t of p.tasks) {
    const row = document.createElement('div');
    row.className = 'taskrow';
    row.dataset.done = t.done ? 'true' : 'false';

    const check = document.createElement('button');
    check.type = 'button';
    check.className = 'taskcheck';
    check.setAttribute('aria-label', t.done ? `Mark "${t.text}" as not done` : `Mark "${t.text}" as done`);
    check.setAttribute('aria-pressed', String(!!t.done));
    check.innerHTML = t.done
      ? '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="3">'
        + '<polyline points="20 6 9 17 4 12"/></svg>'
      : '';
    check.addEventListener('click', () => {
      const tasks = plan().tasks.map(x => (x.id === t.id ? { ...x, done: !x.done } : x));
      writePlan({ ...plan(), tasks });
    });

    const text = document.createElement('span');
    text.className = 'taskrow__text';
    text.textContent = t.text;
    if (t.stage) {
      const stage = document.createElement('span');
      stage.className = 'taskrow__stage';
      stage.textContent = t.stage;
      text.appendChild(stage);
    }

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'icon-btn icon-btn--sm';
    del.setAttribute('aria-label', `Delete ${t.text}`);
    del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" '
      + 'stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    del.addEventListener('click', () => {
      writePlan({ ...plan(), tasks: plan().tasks.filter(x => x.id !== t.id) });
    });

    row.append(check, text, del);
    list.appendChild(row);
  }
}

function renderPicker() {
  const picker = ctx.el.planPicker;
  picker.innerHTML = '';
  const map = activities();
  const current = brushActivity();
  const brushKey = eraseMode ? '' : (current ? current.key : '');

  for (const a of map.values()) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pick';
    btn.dataset.tone = String(toneOf(a.key));
    btn.dataset.kind = a.kind;
    btn.setAttribute('aria-pressed', String(a.key === brushKey));
    btn.innerHTML = `<span class="pick__dot"></span><span class="pick__label">${escapeHtml(a.label)}</span>`
      + `<span class="pick__code">${escapeHtml(codeOf(a.label))}</span>`;
    btn.addEventListener('click', () => {
      eraseMode = false;
      ctx.state.settings.brush = a.key;
      ctx.save();
      renderPicker();
    });
    picker.appendChild(btn);
  }

  const erase = document.createElement('button');
  erase.type = 'button';
  erase.className = 'pick pick--erase';
  erase.setAttribute('aria-pressed', String(eraseMode));
  erase.innerHTML = '<span class="pick__dot"></span><span class="pick__label">Erase</span>';
  erase.addEventListener('click', () => {
    eraseMode = !eraseMode;
    renderPicker();
  });
  picker.appendChild(erase);
}

/* ── painting ────────────────────────────────────────────── */

function slotFromEvent(e, track) {
  const rect = track.getBoundingClientRect();
  const slotH = rect.height / HALF;
  const row = Math.floor((e.clientY - rect.top) / slotH);
  if (row < 0 || row >= HALF) return -1;
  const col = Number(track.dataset.col);
  return col * HALF + row;
}

function paintAt(slot) {
  if (slot < 0 || slot >= SLOTS) return;
  const activity = brushActivity();
  const next = paintSlot(plan().blocks, slot, activity);
  writePlan({ ...plan(), blocks: next });
}

/* ── events ──────────────────────────────────────────────── */

function bindEvents() {
  const { el } = ctx;

  el.planPrev.addEventListener('click', () => setPlannerDate(shiftKey(currentDate, -1)));
  el.planNext.addEventListener('click', () => setPlannerDate(shiftKey(currentDate, 1)));
  el.planToday.addEventListener('click', () => setPlannerDate(dateKey(Date.now())));

  el.planWeek.addEventListener('click', (e) => {
    const btn = e.target.closest('.weekday');
    if (!btn) return;
    const idx = [...el.planWeek.children].indexOf(btn);
    if (idx >= 0) setPlannerDate(shiftKey(currentDate, idx - 3));
  });

  el.planGrid.addEventListener('pointerdown', (e) => {
    const track = e.target.closest('.grid__track');
    if (!track) return;
    painting = true;
    paintAt(slotFromEvent(e, track));
    // Capturing the pointer keeps the drag alive outside the track — but a
    // browser that refuses the capture must not stop the painting.
    try { track.setPointerCapture?.(e.pointerId); } catch { /* no capture */ }
    e.preventDefault();
  });

  el.planGrid.addEventListener('pointermove', (e) => {
    if (!painting) return;
    const track = e.target.closest('.grid__track');
    if (!track) return;
    paintAt(slotFromEvent(e, track));
  });

  const stopPainting = () => { painting = false; };
  el.planGrid.addEventListener('pointerup', stopPainting);
  el.planGrid.addEventListener('pointercancel', stopPainting);
  el.planGrid.addEventListener('pointerleave', stopPainting);
  window.addEventListener('pointerup', stopPainting);

  el.planTaskForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = el.planTaskInput.value.trim();
    if (!text) return;
    const stage = el.planTaskStage.value;
    const task = { id: uid('t'), text: text.slice(0, 120), stage, done: false, createdAt: Date.now() };
    writePlan({ ...plan(), tasks: [...plan().tasks, task] });
    el.planTaskInput.value = '';
  });

  el.planAddActivity.addEventListener('click', () => {
    const name = window.prompt('Name this activity');
    if (!name || !name.trim()) return;
    const label = name.trim().slice(0, 40);
    const key = `custom:${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`
      + `-${Date.now().toString(36).slice(-4)}`;
    const custom = [...ctx.state.activities, { key, label, kind: 'study' }];
    ctx.state.activities = custom;
    ctx.state.settings.brush = key;
    ctx.save();
    eraseMode = false;
    renderPicker();
    ctx.toast(`Added "${label}"`);
  });

  el.planClear.addEventListener('click', () => {
    if (!plan().blocks.length && !plan().tasks.length) {
      ctx.toast('Nothing to clear');
      return;
    }
    if (!window.confirm(`Clear the plan for ${labelDate(currentDate, { month: 'long', day: 'numeric' })}?`)) return;
    writePlan({ ...plan(), blocks: [], tasks: [], imported: null });
  });

  el.planCopy.addEventListener('click', () => ctx.onCopyRequest(currentDate));
}

/* ── importing a timetable ───────────────────────────────── */ 

export function importIntoPlan(date, blocks, meta = {}) {
  const extra = customActivitiesFor(blocks, ctx.state.activities);
  if (extra.length) {
    ctx.state.activities = [...ctx.state.activities, ...extra];
  }
  const p = ctx.getPlan(date);
  writePlan({
    ...p,
    date,
    blocks,
    imported: { label: meta.label || '', subjects: meta.subjects || [] },
    done: {},
  });
  return blocks.length;
}

/* ── helpers ─────────────────────────────────────────────── */

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
