/**
 * Cadence — the plan page controller.
 *
 * The plan page owns the day grid, tasks, timetable import, saving a plan to
 * the timer, downloading a PDF, and "Continue Timetable". The clock page owns
 * the timer itself. They talk through the shared runtime and the store.
 */

import { load, save, getPlan, setPlan, savePlanForTimer } from './store.js';
import {
  SLOT_MIN, SLOTS, activityMap, toneOf, codeOf,
  paintSlot, removeBlock, planSummary, blockRangeLabel, customActivitiesFor, dayProgress, pendingWork, resizeBlock,
} from './plan.js';
import { dateKey, shiftKey, labelDate, clockLabel, humanDuration, minutesOfDay, uid } from './util.js';
import { importTimetable, importErrorMessage } from './timetable-import.js';
import { buildPlanPdf, downloadPlanPdf } from './pdfwrite.js';
import { handOverToClock, runningSession } from './runtime.js';

const HALF = 24;
const COL_MIN = 720;

let state = load();
let currentDate = dateKey(Date.now());
let painting = false;
let eraseMode = false;

const $ = (id) => document.getElementById(id);

const el = {
  planPrev: $('planPrev'),
  planNext: $('planNext'),
  planToday: $('planToday'),
  planTitle: $('planTitle'),
  planSub: $('planSub'),
  planWeek: $('planWeek'),
  planGrid: $('planGrid'),
  planTracks: [document.querySelector('.grid__track[data-col="0"]'), document.querySelector('.grid__track[data-col="1"]')],
  planGutters: [document.querySelector('.grid__gutter[data-col="0"]'), document.querySelector('.grid__gutter[data-col="1"]')],
  planPicker: $('planPicker'),
  planAddActivity: $('planAddActivity'),
  planBlocks: $('planBlocks'),
  planTaskForm: $('planTaskForm'),
  planTaskInput: $('planTaskInput'),
  planTaskStage: $('planTaskStage'),
  planTasks: $('planTasks'),
  planTaskCount: $('planTaskCount'),
  planImport: $('planImport'),
  planImportFile: $('planImportFile'),
  planSaveTimer: $('planSaveTimer'),
  planDownloadPdf: $('planDownloadPdf'),
  planCopy: $('planCopy'),
  planClear: $('planClear'),
  ttDrop: $('ttDrop'),
  ttPick: $('ttPick'),
  ttFile: $('ttFile'),
  ttBanner: $('ttBanner'),
  ttContinueBtn: $('ttContinueBtn'),
  ttCurrent: $('ttCurrent'),
  ttNext: $('ttNext'),
  ttPlanTaskCount: $('ttPlanTaskCount'),
  ttPlanTaskList: $('ttPlanTaskList'),
  ttPlanSubjects: $('ttPlanSubjects'),
  planRuntimeChip: $('planRuntimeChip'),
  planRuntimeText: $('planRuntimeText'),
  planThemeBtn: $('planThemeBtn'),
  toast: $('toast'),
  copyDialog: $('copyDialog'),
  copyClose: $('copyClose'),
  copyOptions: $('copyOptions'),
  copyCancel: $('copyCancel'),
};

function showToast(msg) {
  if (!el.toast) return;
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(showToast.t);
  showToast.t = setTimeout(() => { el.toast.hidden = true; }, 1800);
}

function plan() { return getPlan(state, currentDate); }
function writePlan(next) { setPlan(state, currentDate, next); state = load(); render(); }

function activities() { return activityMap(state.activities); }
function brushActivity() {
  if (eraseMode) return null;
  const map = activities();
  const key = state.settings.brush;
  return map.get(key) || map.get('self_study') || { key: 'self_study', label: 'Self study', kind: 'study' };
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function updateRuntimeChip() {
  const rt = runningSession();
  if (!el.planRuntimeChip) return;
  if (rt) {
    el.planRuntimeChip.hidden = false;
    el.planRuntimeText.textContent = rt.status === 'paused' ? 'Timer paused' : 'Timer running';
  } else {
    el.planRuntimeChip.hidden = true;
  }
}

function render() {
  const p = plan();
  const summary = planSummary(p);
  const today = dateKey(Date.now());
  const isToday = currentDate === today;

  el.planTitle.textContent = labelDate(currentDate, { weekday: 'long', day: 'numeric', month: 'long' });
  const bits = [];
  if (isToday) bits.push('Today');
  bits.push(`${summary.blocks} block${summary.blocks === 1 ? '' : 's'}`);
  if (summary.studyMin) bits.push(`${humanDuration(summary.studyMin * 60000)} study`);
  if (summary.freeMin) bits.push(`${humanDuration(summary.freeMin * 60000)} free`);
  if (summary.tasks) bits.push(`${summary.tasksDone}/${summary.tasks} tasks`);
  el.planSub.textContent = bits.join(' · ');

  renderWeekStrip();
  renderGrid(p);
  renderBlockList(p);
  renderTasks(p);
  renderPicker();
  renderTimetableCard(p);
  updateRuntimeChip();
}

function renderWeekStrip() {
  const strip = el.planWeek;
  if (!strip) return;
  strip.innerHTML = '';
  const today = dateKey(Date.now());
  for (let i = -3; i <= 3; i += 1) {
    const key = shiftKey(currentDate, i);
    const pp = getPlan(state, key);
    const has = pp.blocks.length > 0;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'weekday';
    if (key === currentDate) btn.setAttribute('aria-current', 'date');
    btn.dataset.has = has ? 'true' : 'false';
    btn.dataset.today = key === today ? 'true' : 'false';
    btn.title = labelDate(key, { weekday: 'long', day: 'numeric', month: 'long' });
    btn.innerHTML = `<span class="weekday__name">${labelDate(key, { weekday: 'short' })}</span><span class="weekday__num">${key.slice(8)}</span><span class="weekday__dot"></span>`;
    btn.addEventListener('click', () => { currentDate = key; render(); });
    strip.appendChild(btn);
  }
}

function renderGrid(p) {
  const map = activities();
  for (const col of [0, 1]) {
    const track = el.planTracks[col];
    const gutter = el.planGutters[col];
    if (!track || !gutter) continue;
    track.innerHTML = '';
    gutter.innerHTML = '';

    for (let row = 0; row < HALF; row += 1) {
      const mins = col * COL_MIN + row * SLOT_MIN;
      const label = document.createElement('span');
      label.className = 'grid__hour';
      if (mins % 60 === 0) {
        label.textContent = clockLabel(mins).replace(':00', '');
        label.classList.add('is-hour');
      } else if (mins % 30 === 0) {
        label.textContent = clockLabel(mins).split(':')[1] === '30' ? ':30' : '';
        if (label.textContent) label.classList.add('is-half');
      }
      gutter.appendChild(label);
    }

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
      const elb = document.createElement('div');
      elb.className = 'grid__block';
      elb.dataset.key = b.key;
      elb.dataset.tone = String(toneOf(b.key));
      elb.dataset.kind = act?.kind || b.kind;
      elb.style.setProperty('--row', String(rowStart));
      elb.style.setProperty('--span', String(rowEnd - rowStart));
      elb.title = `${b.label} · ${blockRangeLabel(b)}`;
      elb.innerHTML = `<span class="grid__blocklabel">${escapeHtml(b.label)}</span><span class="grid__blockcode">${escapeHtml(codeOf(b.label))} · ${humanDuration((b.endMin - b.startMin) * 60000)}</span>`;
      track.appendChild(elb);
    }

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
  const list = el.planBlocks;
  if (!list) return;
  list.innerHTML = '';
  if (!p.blocks.length) {
    list.innerHTML = '<p class="empty">Nothing planned yet. Pick an activity and drag across the grid.</p>';
    return;
  }
  const sorted = [...p.blocks].sort((a,b) => a.startMin - b.startMin);
  for (const b of sorted) {
    const row = document.createElement('div');
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

    const shrink = document.createElement('button');
    shrink.type = 'button';
    shrink.className = 'icon-btn icon-btn--sm';
    shrink.setAttribute('aria-label', `Shorten ${b.label} by 30 min`);
    shrink.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 12h14"/></svg>';
    shrink.addEventListener('click', () => writePlan({ ...plan(), blocks: resizeBlock(plan().blocks, b.id, 'end', -30) }));

    const grow = document.createElement('button');
    grow.type = 'button';
    grow.className = 'icon-btn icon-btn--sm';
    grow.setAttribute('aria-label', `Extend ${b.label} by 30 min`);
    grow.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
    grow.addEventListener('click', () => writePlan({ ...plan(), blocks: resizeBlock(plan().blocks, b.id, 'end', 30) }));

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'icon-btn icon-btn--sm';
    del.setAttribute('aria-label', `Remove ${b.label}`);
    del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    del.addEventListener('click', () => writePlan({ ...plan(), blocks: removeBlock(plan().blocks, b.id) }));
    actions.append(shrink, grow, del);

    row.append(main, actions);
    list.appendChild(row);
  }
}

function renderTasks(p) {
  const list = el.planTasks;
  if (!list) return;
  list.innerHTML = '';
  if (el.planTaskCount) el.planTaskCount.textContent = p.tasks.length ? `· ${p.tasks.filter(t => t.done).length}/${p.tasks.length}` : '';

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
    check.innerHTML = t.done ? '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>' : '';
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
    del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    del.addEventListener('click', () => writePlan({ ...plan(), tasks: plan().tasks.filter(x => x.id !== t.id) }));

    row.append(check, text, del);
    list.appendChild(row);
  }
}

function renderPicker() {
  const picker = el.planPicker;
  if (!picker) return;
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
    btn.innerHTML = `<span class="pick__dot"></span><span class="pick__label">${escapeHtml(a.label)}</span><span class="pick__code">${escapeHtml(codeOf(a.label))}</span>`;
    btn.addEventListener('click', () => {
      eraseMode = false;
      state.settings.brush = a.key;
      save(state);
      renderPicker();
    });
    picker.appendChild(btn);
  }

  const erase = document.createElement('button');
  erase.type = 'button';
  erase.className = 'pick pick--erase';
  erase.setAttribute('aria-pressed', String(eraseMode));
  erase.innerHTML = '<span class="pick__dot"></span><span class="pick__label">Erase</span>';
  erase.addEventListener('click', () => { eraseMode = !eraseMode; renderPicker(); });
  picker.appendChild(erase);
}

function renderTimetableCard(p) {
  const mins = minutesOfDay();
  const isToday = currentDate === dateKey(Date.now());
  const { current, next } = dayProgress(p.blocks, mins, isToday);

  if (el.ttCurrent) el.ttCurrent.textContent = current ? `${current.label} · ${blockRangeLabel(current)}` : (p.blocks.length ? 'No block running now' : '—');
  if (el.ttNext) el.ttNext.textContent = next ? `${next.label} · ${blockRangeLabel(next)}` : (current ? 'Plan complete' : (p.blocks.length ? '—' : '—'));

  const pw = pendingWork(p);
  if (el.ttPlanTaskCount) el.ttPlanTaskCount.textContent = `${pw.left}/${pw.total}`;

  if (el.ttPlanTaskList) {
    el.ttPlanTaskList.innerHTML = '';
    if (!pw.tasks.length) {
      el.ttPlanTaskList.innerHTML = '<p class="hint">No tasks</p>';
    } else {
      for (const t of pw.tasks.slice(0, 6)) {
        const row = document.createElement('div');
        row.className = 'timetable-taskrow';
        row.textContent = t.done ? `✓ ${t.text}` : `• ${t.text}`;
        el.ttPlanTaskList.appendChild(row);
      }
      if (pw.tasks.length > 6) {
        const more = document.createElement('div');
        more.className = 'hint';
        more.textContent = `+${pw.tasks.length - 6} more`;
        el.ttPlanTaskList.appendChild(more);
      }
    }
  }

  if (el.ttPlanSubjects) {
    const subjects = Array.isArray(p.imported?.subjects) ? p.imported.subjects : [];
    if (subjects.length) {
      el.ttPlanSubjects.hidden = false;
      el.ttPlanSubjects.innerHTML = subjects.map(s => `<span class="subject-pill">${escapeHtml(s.name)} ${s.done}/${s.total}</span>`).join('');
    } else {
      el.ttPlanSubjects.hidden = true;
      el.ttPlanSubjects.innerHTML = '';
    }
  }
}

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

function bindEvents() {
  el.planPrev?.addEventListener('click', () => { currentDate = shiftKey(currentDate, -1); render(); });
  el.planNext?.addEventListener('click', () => { currentDate = shiftKey(currentDate, 1); render(); });
  el.planToday?.addEventListener('click', () => { currentDate = dateKey(Date.now()); render(); });

  el.planGrid?.addEventListener('pointerdown', (e) => {
    const track = e.target.closest('.grid__track');
    if (!track) return;
    painting = true;
    paintAt(slotFromEvent(e, track));
    try { track.setPointerCapture?.(e.pointerId); } catch {}
    e.preventDefault();
  });
  el.planGrid?.addEventListener('pointermove', (e) => {
    if (!painting) return;
    const track = e.target.closest('.grid__track');
    if (!track) return;
    paintAt(slotFromEvent(e, track));
  });
  const stopPainting = () => { painting = false; };
  el.planGrid?.addEventListener('pointerup', stopPainting);
  el.planGrid?.addEventListener('pointercancel', stopPainting);
  el.planGrid?.addEventListener('pointerleave', stopPainting);
  window.addEventListener('pointerup', stopPainting);

  el.planTaskForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = el.planTaskInput.value.trim();
    if (!text) return;
    const stage = el.planTaskStage?.value || '';
    const task = { id: uid('t'), text: text.slice(0, 120), stage, done: false, createdAt: Date.now() };
    writePlan({ ...plan(), tasks: [...plan().tasks, task] });
    el.planTaskInput.value = '';
  });

  el.planAddActivity?.addEventListener('click', () => {
    const name = window.prompt('Name this activity');
    if (!name || !name.trim()) return;
    const label = name.trim().slice(0, 40);
    const key = `custom:${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${Date.now().toString(36).slice(-4)}`;
    state.activities = [...state.activities, { key, label, kind: 'study' }];
    state.settings.brush = key;
    save(state);
    eraseMode = false;
    state = load();
    render();
    showToast(`Added "${label}"`);
  });

  el.planClear?.addEventListener('click', () => {
    if (!plan().blocks.length && !plan().tasks.length) { showToast('Nothing to clear'); return; }
    if (!window.confirm(`Clear the plan for ${labelDate(currentDate, { month: 'long', day: 'numeric' })}?`)) return;
    writePlan({ ...plan(), blocks: [], tasks: [], imported: null, done: {} });
  });

  el.planCopy?.addEventListener('click', () => openCopyDialog());
  el.copyClose?.addEventListener('click', () => el.copyDialog?.close?.());
  el.copyCancel?.addEventListener('click', () => el.copyDialog?.close?.());
  el.copyOptions?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-copy-from]');
    if (!btn) return;
    copyDay(btn.dataset.copyFrom);
  });

  el.planImport?.addEventListener('click', () => el.planImportFile?.click());
  el.planImportFile?.addEventListener('change', async () => {
    const file = el.planImportFile.files?.[0];
    el.planImportFile.value = '';
    if (!file) return;
    try {
      const result = await importTimetable(state, file);
      state = load();
      currentDate = result.date;
      showToast(`Imported ${result.blocks} blocks · ${result.label}`);
      render();
    } catch (err) {
      showToast(importErrorMessage(err));
    }
  });

  el.ttPick?.addEventListener('click', (e) => { e.stopPropagation(); el.ttFile?.click(); });
  el.ttDrop?.addEventListener('click', () => el.ttFile?.click());
  el.ttDrop?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.ttFile?.click(); }
  });
  el.ttFile?.addEventListener('change', async () => {
    const file = el.ttFile.files?.[0];
    el.ttFile.value = '';
    if (!file) return;
    try {
      const result = await importTimetable(state, file);
      state = load();
      currentDate = result.date;
      showToast(`Imported ${result.blocks} blocks · ${result.label}`);
      render();
    } catch (err) {
      showToast(importErrorMessage(err));
    }
  });
  ['dragenter', 'dragover'].forEach(type => {
    el.ttDrop?.addEventListener(type, (e) => { e.preventDefault(); e.stopPropagation(); el.ttDrop.dataset.dragging = 'true'; });
  });
  ['dragleave', 'drop'].forEach(type => {
    el.ttDrop?.addEventListener(type, (e) => { e.preventDefault(); e.stopPropagation(); el.ttDrop.dataset.dragging = 'false'; });
  });
  el.ttDrop?.addEventListener('drop', async (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    try {
      const result = await importTimetable(state, file);
      state = load();
      currentDate = result.date;
      showToast(`Imported ${result.blocks} blocks · ${result.label}`);
      render();
    } catch (err) {
      showToast(importErrorMessage(err));
    }
  });

  el.ttContinueBtn?.addEventListener('click', () => continueTimetable());

  el.planSaveTimer?.addEventListener('click', () => {
    const p = plan();
    if (!p.blocks.length) { showToast('Nothing to save'); return; }
    savePlanForTimer(state, p, p.imported?.label || labelDate(currentDate, { weekday: 'long', month: 'long', day: 'numeric' }));
    save(state);
    showToast('Saved to timer');
  });

  el.planDownloadPdf?.addEventListener('click', () => downloadPlan(currentDate));

  el.planThemeBtn?.addEventListener('click', () => {
    const html = document.documentElement;
    const next = html.dataset.theme === 'graphite' ? 'void' : 'graphite';
    html.dataset.theme = next;
    state.settings.theme = next;
    save(state);
    showToast(next === 'graphite' ? 'Graphite theme' : 'Void theme');
  });

  setInterval(updateRuntimeChip, 30000);
}

function openCopyDialog() {
  const today = dateKey(Date.now());
  const options = [
    { key: shiftKey(currentDate, -1), label: 'Previous day' },
    { key: shiftKey(currentDate, -7), label: 'Last week' },
    { key: today, label: 'Today' },
  ];
  if (!el.copyOptions) return;
  el.copyOptions.innerHTML = '';
  for (const o of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'modal-option';
    btn.dataset.copyFrom = o.key;
    btn.innerHTML = `<div><div class="mo-title">${o.label}</div><div class="mo-sub">${labelDate(o.key, { month: 'short', day: 'numeric' })}</div></div>`;
    el.copyOptions.appendChild(btn);
  }
  if (typeof el.copyDialog?.showModal === 'function') el.copyDialog.showModal();
  else el.copyDialog?.setAttribute('open', '');
}

function copyDay(fromDate) {
  if (fromDate === currentDate) { showToast('That is the same day'); return; }
  const from = getPlan(state, fromDate);
  if (!from.blocks.length) { showToast('Nothing planned on that day'); return; }
  const to = plan();
  writePlan({
    ...to,
    blocks: from.blocks.map(b => ({ ...b, id: uid('b') })),
    imported: from.imported ? { ...from.imported } : null,
    done: {},
  });
  el.copyDialog?.close?.();
  showToast('Plan copied');
}

function continueTimetable(date = dateKey(Date.now())) {
  const p = getPlan(state, date);
  if (!p.blocks.length) { showToast('Nothing is planned for that day'); return; }
  const isToday = date === dateKey(Date.now());
  const mins = minutesOfDay();
  const { current, next } = dayProgress(p.blocks, mins, isToday);
  const block = current || next;
  if (!block) { showToast('That day is done — nothing left to run'); return; }
  let remaining = (block.endMin - block.startMin) * 60000;
  if (current && isToday) {
    const endTs = Date.now() - (mins * 60000) + (block.endMin * 60000);
    remaining = Math.max(1000, endTs - Date.now());
  }
  const kind = block.kind === 'rest' ? 'break' : 'focus';
  handOverToClock({ subject: block.label, sessionId: block.id, target: remaining, kind, date });
  window.location.href = './clock.html';
}

function downloadPlan(date) {
  const p = getPlan(state, date);
  const blocks = p.blocks.map(b => ({
    range: blockRangeLabel(b),
    label: b.label,
    duration: humanDuration((b.endMin - b.startMin) * 60000),
  }));
  const tasks = (p.tasks || []).map(t => ({ text: t.text, done: !!t.done }));
  if (Array.isArray(p.imported?.subjects)) {
    for (const s of p.imported.subjects) {
      if (s && s.name) tasks.push({ text: `${s.name}: ${s.done}/${s.total}`, done: Number(s.done) >= Number(s.total) && Number(s.total) > 0 });
    }
  }
  downloadPlanPdf({
    title: `Cadence plan — ${labelDate(date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`,
    subtitle: p.imported?.label || '',
    blocks,
    tasks,
    footer: 'Generated by Cadence — plan the day, run the day',
  }, `cadence-plan-${date}.pdf`);
  showToast('PDF downloaded');
}

function init() {
  bindEvents();
  render();
  updateRuntimeChip();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      state = load();
      render();
      updateRuntimeChip();
    }
  });
  window.addEventListener('focus', () => {
    state = load();
    render();
    updateRuntimeChip();
  });
}

init();
