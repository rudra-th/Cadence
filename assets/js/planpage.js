/**
 * Cadence — the plan page controller.
 *
 * The plan page owns the day grid, the tasks, timetable import, saving a plan
 * to the timer, downloading a PDF, and handing the day over to the clock.
 * The clock page owns the timer itself. They talk through the shared runtime
 * and the store.
 *
 * The grid is a paint tool. Pick an activity, press on a square and drag:
 * every square the pointer crosses ends up holding that activity. The drag
 * runs straight through noon into the second column, and dragging back over
 * your own work never leaves a seam behind.
 */

import { load, save, saveNow, getPlan, setPlan, savePlanForTimer } from './store.js';
import {
  SLOT_MIN, DAY_MIN, activityMap, toneOf, ACTIVITIES,
  paintRange, removeBlock, mergeBlocks, moveBlock, resizeBlockTo,
  planSummary, blockRangeLabel, dayProgress,
} from './plan.js';
import { dateKey, shiftKey, labelDate, clockLabel, humanDuration, minutesOfDay, uid, clamp } from './util.js';
import { importTimetable, importErrorMessage } from './timetable-import.js';
import { buildPlanPrint } from './printplan.js';
import { handOverToClock, runningSession } from './runtime.js';
import { sanitizePlan, sanitizeSettings, sanitizeSessions, sanitizePlans, sanitizeActivities, saveNow } from './store.js';

const HALF = 24;              // squares in one column (12 hours)
const COL_MIN = 720;          // minutes in one column
const COLS = 2;
const LEAVE_MARGIN = 64;      // px outside the grid where a drag gives up

let state = load();
let currentDate = dateKey(Date.now());
let current = getPlan(state, currentDate);   // the plan that is on screen
let brushKey = state.settings.brush || 'self_study';
let eraseMode = false;
let selectedId = '';
let drag = null;              // the gesture in progress, if any
let history = [];             // undo
let future = [];              // redo

/* Last-used print style, remembered in the store. */
let printOpts = { ...state.settings.print };

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
  planInspector: $('planInspector'),
  inspDot: $('inspDot'),
  inspTitle: $('inspTitle'),
  inspMeta: $('inspMeta'),
  planTaskForm: $('planTaskForm'),
  planTaskInput: $('planTaskInput'),
  planTaskStage: $('planTaskStage'),
  planTasks: $('planTasks'),
  planTaskCount: $('planTaskCount'),
  planImport: $('planImport'),
  planImportFile: $('planImportFile'),
  planStart: $('planStart'),
  planSaveTimer: $('planSaveTimer'),
  planPrint: $('planPrint'),
  printDoc: $('printDoc'),
  planDownloadPdf: $('planDownloadPdf'),
  printDialog: $('printDialog'),
  printPreview: $('printPreview'),
  printHint: $('printHint'),
  printClose: $('printClose'),
  printCancel: $('printCancel'),
  printGo: $('printGo'),
  planCopy: $('planCopy'),
  planClear: $('planClear'),
  planUndo: $('planUndo'),
  planRedo: $('planRedo'),
  planNow: $('planNow'),
  planRuntimeChip: $('planRuntimeChip'),
  planRuntimeText: $('planRuntimeText'),
  planThemeBtn: $('planThemeBtn'),
  toast: $('toast'),
  copyDialog: $('copyDialog'),
  copyClose: $('copyClose'),
  copyOptions: $('copyOptions'),
  copyCancel: $('copyCancel'),
  dropOverlay: $('dropOverlay'),
};

/* ── small helpers ────────────────────────────────────────── */

function showToast(msg) {
  if (!el.toast) return;
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(showToast.t);
  showToast.t = setTimeout(() => { el.toast.hidden = true; }, 1800);
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function activities() { return activityMap(state.activities); }

function blocks() { return Array.isArray(current.blocks) ? current.blocks : []; }

function tasks() { return Array.isArray(current.tasks) ? current.tasks : []; }

/** The activity the brush is holding, or null when the brush is an eraser. */
function brushActivity() {
  if (eraseMode) return null;
  const map = activities();
  return map.get(brushKey)
    || map.get('self_study')
    || { key: 'self_study', label: 'Self study', kind: 'study' };
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

/* ── history ──────────────────────────────────────────────── */

/**
 * The day as it is right now, ready to be put back later.
 *
 * `blocksSnapshot` is for a change that has already happened in memory — a
 * drag paints as it goes, so the state on screen is the *result* of the
 * gesture and the snapshot has to be the one taken when it started.
 */
function snapshot(blocksSnapshot) {
  return {
    date: currentDate,
    blocks: (blocksSnapshot || blocks()).map(b => ({ ...b })),
    tasks: tasks().map(t => ({ ...t })),
    imported: current.imported ? { ...current.imported } : null,
    done: { ...(current.done || {}) },
  };
}

function remember(blocksSnapshot) {
  history.push(snapshot(blocksSnapshot));
  if (history.length > 80) history.shift();
  future.length = 0;
}

/** Put a remembered day back on screen. */
function restore(entry) {
  currentDate = entry.date;
  current = {
    date: entry.date,
    blocks: entry.blocks,
    tasks: entry.tasks,
    imported: entry.imported || null,
    done: entry.done || {},
    updatedAt: Date.now(),
  };
  selectedId = '';
}

function undo() {
  const entry = history.pop();
  if (!entry) { showToast('Nothing to undo'); return; }
  future.push(snapshot());
  restore(entry);
  commit();
}

function redo() {
  const entry = future.pop();
  if (!entry) { showToast('Nothing to redo'); return; }
  history.push(snapshot());
  restore(entry);
  commit();
}

/* ── writing ──────────────────────────────────────────────── */

/**
 * Put the plan on screen back into the store.
 *
 * The write is immediate — the plan is the one thing on this page that must
 * survive the tab being closed, and the debounce in the store would leave the
 * last few seconds of painting on the floor.
 */
function commit() {
  setPlan(state, currentDate, current);
  saveNow(state);
  flashSaved();
  render();
}

/** Show "Saved locally" for a moment after a real planner change. */
let savedTimer = 0;
function flashSaved() {
  if (!el.planSub) return;
  el.planSub.dataset.save = '1';
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { if (el.planSub) el.planSub.dataset.save = ''; }, 1400);
}

function writeBlocks(next) {
  current.blocks = mergeBlocks(next);
  commit();
}

/* ── rendering ────────────────────────────────────────────── */

function render() {
  renderHeader();
  renderWeekStrip();
  renderGrid();
  renderPicker();
  renderInspector();
  renderTasks();
  renderNow();
  updateGridHint();
  updateRuntimeChip();
  renderPrintDoc();
}

function renderHeader() {
  if (!el.planTitle) return;
  const summary = planSummary(current);
  const isToday = currentDate === dateKey(Date.now());

  el.planTitle.textContent = labelDate(currentDate, { weekday: 'long', day: 'numeric', month: 'long' });

  const bits = [];
  if (isToday) bits.push('Today');
  bits.push(`${summary.blocks} block${summary.blocks === 1 ? '' : 's'}`);
  bits.push(`${humanDuration(summary.studyMin * 60000)} study`);
  bits.push(`${humanDuration(summary.restMin * 60000)} rest`);
  bits.push(`${humanDuration(summary.freeMin * 60000)} free`);
  bits.push(`${summary.tasksDone}/${summary.tasks} tasks`);
  if (el.planSub) {
    el.planSub.textContent = bits.join(' · ');
  } else if (el.planTitle) {
    // fallback
    const el2 = document.getElementById('planSub');
    if (el2) el2.textContent = bits.join(' · ');
  }

  if (el.planUndo) el.planUndo.disabled = !history.length;
  if (el.planRedo) el.planRedo.disabled = !future.length;
}

/**
 * Keep the hidden print view in step with the day on screen. It is cheap, and
 * it means Ctrl+P works even if the browser fires `beforeprint` late.
 */

/** Put the current style on a print container and fill it with the day. */
function paintPrintDoc(target) {
  if (!target) return;
  target.dataset.theme = printOpts.theme;
  target.dataset.colour = printOpts.colour;
  target.classList.toggle('printdoc--zen', printOpts.layout === 'zen');

  // A long day gets a tighter rhythm so it still fits on one sheet. Zen
  // already has generous rows, so it is left alone.
  const blockCount = Array.isArray(current.blocks) ? current.blocks.length : 0;
  const taskCount = Array.isArray(current.tasks) ? current.tasks.length : 0;
  target.classList.toggle(
    'printdoc--dense',
    printOpts.layout !== 'zen' && (blockCount > 14 || taskCount > 6),
  );

  target.innerHTML = buildPlanPrint({
    plan: current,
    date: currentDate,
    theme: printOpts.theme,
    colour: printOpts.colour,
    zen: printOpts.layout === 'zen',
  });
}

function renderPrintDoc() {
  paintPrintDoc(el.printDoc);
}

function renderPrintPreview() {
  paintPrintDoc(el.printPreview);
}

/** One line under the options that says what the current choice does. */
function updatePrintHint() {
  if (!el.printHint) return;
  const bits = [];
  if (printOpts.theme === 'dark') bits.push('Dark is ink-heavy — best when you save as PDF.');
  if (printOpts.colour === 'grey') bits.push('Grey keeps the app’s monochrome palette.');
  if (printOpts.layout === 'zen') bits.push('Zen prints only the date, the strip and the schedule.');
  if (!bits.length) bits.push('Stats, strip, schedule, tasks and breakdown.');
  el.printHint.textContent = bits.join(' ');
}

/** Show the stored choices in the dialog's radio buttons. */
function syncPrintControls() {
  const dialog = el.printDialog;
  if (!dialog) return;
  const set = (name, value) => {
    const input = dialog.querySelector(`input[name="${name}"][value="${value}"]`);
    if (input) input.checked = true;
  };
  set('printTheme', printOpts.theme);
  set('printColour', printOpts.colour);
  set('printLayout', printOpts.layout);
  updatePrintHint();
}

function openPrintDialog() {
  if (!el.printDialog || typeof el.printDialog.showModal !== 'function') {
    printPlan();
    return;
  }
  delete el.printDialog.dataset.pdf;
  const go = el.printGo;
  if (go) go.textContent = 'Print';
  syncPrintControls();
  renderPrintPreview();
  if (!el.printDialog.open) el.printDialog.showModal();
}

/** Apply the style to the real sheet, then hand over to the system dialog. */
function printPlan() {
  renderPrintDoc();
  document.documentElement.dataset.printTheme = printOpts.theme;
  window.print();
}

let pdfMode = false;

/** Open the style dialog and download the day as a PDF straight away. */
async function downloadPdf() {
  if (!el.printDialog || typeof el.printDialog.showModal !== 'function') {
    await exportPdf();
    return;
  }
  syncPrintControls();
  renderPrintPreview();
  delete el.printDialog.dataset.pdfGo;
  el.printDialog.dataset.pdf = '1';
  const go = el.printGo;
  const oldLabel = go?.textContent;
  if (go) go.textContent = 'Download';
  try {
    if (!el.printDialog.open) el.printDialog.showModal();
  } catch {}
  const onClose = async () => {
    const confirmed = el.printDialog?.dataset.pdfGo === '1';
    delete el.printDialog.dataset.pdf;
    delete el.printDialog.dataset.pdfGo;
    if (go) go.textContent = oldLabel || 'Print';
    if (confirmed) await exportPdf();
  };
  el.printDialog.addEventListener('close', onClose, { once: true });
}

/** Load the two rendering libraries only when a PDF is actually requested. */
function loadScriptOnce(src) {
  if ([...document.scripts].some(s => s.src === new URL(src, location.href).href)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(s);
  });
}

async function exportPdf() {
  try {
    await Promise.all([
      loadScriptOnce('./assets/vendor/html2canvas.min.js'),
      loadScriptOnce('./assets/vendor/jspdf.umd.min.js'),
    ]);
  } catch (err) {
    showToast('PDF library failed to load — check your connection');
    return;
  }
  const html2canvas = window.html2canvas;
  const JsPDF = window.jspdf?.jsPDF;
  const sheet = el.printDoc;
  if (!html2canvas || !JsPDF || !sheet) { showToast('PDF export is unavailable'); return; }

  prepareForPdf();
  sheet.classList.add('printdoc--capture');
  try {
    if (document.fonts?.ready) await document.fonts.ready;
    const canvas = await html2canvas(sheet, {
      backgroundColor: null,
      scale: 2,
      useCORS: true,
      logging: false,
      width: sheet.offsetWidth,
      height: sheet.offsetHeight,
      windowWidth: sheet.offsetWidth,
      windowHeight: sheet.offsetHeight,
    });
    const pdf = new JsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    pdf.addImage(canvas.toDataURL('image/jpeg', 0.94), 'JPEG', 0, 0, 210, 297);
    try {
      const data = JSON.stringify({ type: 'cadence-plan', date: currentDate, plan: current, exportedAt: Date.now() });
      pdf.setFontSize(1);
      pdf.text(data, -1000, -1000);
      pdf.addPage();
      pdf.setFontSize(1);
      pdf.text(data, -1000, -1000);
    } catch {}
    const name = 'Cadence — ' + labelDate(currentDate, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).replace(/,/g, '') + '.pdf';
    pdf.save(name);
    showToast('PDF downloaded');
  } catch (err) {
    console.error(err);
    showToast('Could not build the PDF');
  } finally {
    sheet.classList.remove('printdoc--capture');
    endPdf();
  }
}


/** Build the print sheet in A4, ready to capture as a PDF. */
function prepareForPdf() {
  pdfMode = true;
  if (el.printDoc) el.printDoc.classList.add('printdoc--pdf');
  renderPrintDoc();
  document.documentElement.dataset.printTheme = printOpts.theme;
}

/** Stop forcing full-page layout after a PDF export. */
function endPdf() {
  pdfMode = false;
  if (el.printDoc) el.printDoc.classList.remove('printdoc--pdf');
  delete document.documentElement.dataset.printTheme;
}

function renderWeekStrip() {
  const strip = el.planWeek;
  if (!strip) return;
  strip.innerHTML = '';
  const today = dateKey(Date.now());
  for (let i = -3; i <= 3; i += 1) {
    const key = shiftKey(currentDate, i);
    const pp = getPlan(state, key);
    const s = planSummary(pp);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'weekday';
    if (key === currentDate) btn.setAttribute('aria-current', 'date');
    btn.dataset.has = pp.blocks.length ? 'true' : 'false';
    btn.dataset.today = key === today ? 'true' : 'false';
    btn.title = labelDate(key, { weekday: 'long', day: 'numeric', month: 'long' });
    const fmt = (m) => (m >= 60 ? Math.floor(m/60)+'h'+(m%60? m%60+'m':'') : m? m+'m':'—');
    btn.innerHTML = `<span class="weekday__name">${labelDate(key, { weekday: 'short' })}</span><span class="weekday__num">${key.slice(8)}</span><span class="weekday__meta">S ${fmt(s.studyMin)} · R ${fmt(s.restMin)} · F ${fmt(s.freeMin)}</span><span class="weekday__dot"></span>`;
    btn.addEventListener('click', () => goToDate(key));
    strip.appendChild(btn);
  }
}

/** The hour labels beside each column. They never change, so they are built once. */
function buildGutters() {
  for (const col of [0, 1]) {
    const gutter = el.planGutters[col];
    if (!gutter) continue;
    gutter.innerHTML = '';
    for (let row = 0; row < HALF; row += 1) {
      const mins = col * COL_MIN + row * SLOT_MIN;
      const label = document.createElement('span');
      label.className = 'grid__hour';
      if (mins % 60 === 0) {
        label.textContent = clockLabel(mins).replace(':00', '');
        label.classList.add('is-hour');
      } else {
        label.textContent = ':30';
        label.classList.add('is-half');
      }
      gutter.appendChild(label);
    }
  }
}

function renderGrid() {
  const map = activities();
  const isToday = currentDate === dateKey(Date.now());
  const mins = minutesOfDay();

  for (const col of [0, 1]) {
    const track = el.planTracks[col];
    if (!track) continue;
    track.innerHTML = '';

    if (drag && drag.mode === 'paint') {
      const preview = previewEl(drag.anchorSlot, drag.currentSlot, col);
      if (preview) track.appendChild(preview);
    }

    for (const b of blocks()) {
      const localStart = b.startMin - col * COL_MIN;
      const localEnd = b.endMin - col * COL_MIN;
      if (localEnd <= 0 || localStart >= COL_MIN) continue;
      const from = Math.max(0, localStart);
      const to = Math.min(COL_MIN, localEnd);
      const rowStart = Math.floor(from / SLOT_MIN);
      const rowEnd = Math.ceil(to / SLOT_MIN);
      if (rowEnd <= rowStart) continue;
      track.appendChild(blockEl(b, rowStart, rowEnd - rowStart, map,
        b.startMin >= col * COL_MIN, b.endMin <= (col + 1) * COL_MIN));
    }

    if (isToday) {
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

/**
 * One block on the grid.
 *
 * A block that runs through noon is drawn twice — once in each column. Only
 * the first part carries the name, and only the real start and the real end
 * get a resize handle; the join at noon is just the same block carrying on, so
 * dragging there moves it instead of trimming it to the column edge.
 */
function blockEl(b, row, span, map, first, last) {
  const act = map.get(b.key);
  const elb = document.createElement('div');
  elb.className = 'grid__block';
  elb.dataset.id = b.id;
  elb.dataset.key = b.key;
  elb.dataset.kind = act?.kind || b.kind || 'study';
  elb.dataset.tone = String(toneOf(b.key));
  if (b.id === selectedId) elb.classList.add('is-selected');
  if (span < 2) elb.classList.add('is-short');
  if (!first) elb.classList.add('is-continued');
  elb.style.setProperty('--row', String(row));
  elb.style.setProperty('--span', String(span));
  elb.title = `${b.label} · ${blockRangeLabel(b)}`;
  const parts = [
    '<span class="grid__grip" data-handle="move" aria-hidden="true"></span>',
  ];
  if (first) {
    parts.push(`<span class="grid__blocklabel">${escapeHtml(b.label)}</span>`);
    parts.push(`<span class="grid__blockdur">${escapeHtml(humanDuration((b.endMin - b.startMin) * 60000))}</span>`);
  }
  if (first) parts.push('<span class="grid__edge grid__edge--top" data-handle="start"></span>');
  if (last) parts.push('<span class="grid__edge grid__edge--bottom" data-handle="end"></span>');
  elb.innerHTML = parts.join('');
  return elb;
}

/** The outline of the range being dragged. */
function previewEl(fromSlot, toSlot, col) {
  const lo = Math.min(fromSlot, toSlot);
  const hi = Math.max(fromSlot, toSlot);
  const startMin = lo * SLOT_MIN;
  const endMin = (hi + 1) * SLOT_MIN;
  const localStart = startMin - col * COL_MIN;
  const localEnd = endMin - col * COL_MIN;
  if (localEnd <= 0 || localStart >= COL_MIN) return null;

  const from = Math.max(0, localStart);
  const to = Math.min(COL_MIN, localEnd);
  const rowStart = Math.floor(from / SLOT_MIN);
  const rowEnd = Math.ceil(to / SLOT_MIN);
  if (rowEnd <= rowStart) return null;

  const d = document.createElement('div');
  d.className = 'grid__preview';
  d.style.setProperty('--row', String(rowStart));
  d.style.setProperty('--span', String(rowEnd - rowStart));
  d.innerHTML = `<span class="grid__previewtime">${escapeHtml(clockLabel(startMin))} – ${escapeHtml(clockLabel(endMin))}</span>`;
  return d;
}

/** The bar under the grid that edits the block you picked. */
function renderInspector() {
  const bar = el.planInspector;
  if (!bar) return;
  const b = blocks().find(x => x.id === selectedId);
  if (!b) { bar.hidden = true; return; }
  bar.hidden = false;

  const map = activities();
  const act = map.get(b.key);
  if (el.inspDot) {
    el.inspDot.dataset.kind = act?.kind || b.kind || 'study';
    el.inspDot.dataset.tone = String(toneOf(b.key));
  }
  if (el.inspTitle) el.inspTitle.textContent = b.label;
  if (el.inspMeta) {
    el.inspMeta.textContent = `${blockRangeLabel(b)} · ${humanDuration((b.endMin - b.startMin) * 60000)}`;
  }
  for (const btn of bar.querySelectorAll('[data-act]')) {
    if (btn.dataset.act === 'delete') btn.classList.add('is-danger');
  }
}

function renderPicker() {
  const picker = el.planPicker;
  if (!picker) return;
  picker.innerHTML = '';
  const map = activities();
  const active = brushActivity();

  // Always show the built-in palette first so the picker isn't empty after a
  // fresh profile or a broken import.
  for (const a of ACTIVITIES) {
    if (map.has(a.key)) continue;
    // renderPicker will add from map below, but just in case
  }

  const list = [];
  const seen = new Set();
  for (const a of map.values()) { if (!seen.has(a.key)) { seen.add(a.key); list.push(a); } }
  for (const a of ACTIVITIES) { if (!seen.has(a.key)) { seen.add(a.key); list.push(a); } }

  for (const a of list) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pick';
    btn.dataset.tone = String(toneOf(a.key));
    btn.dataset.kind = a.kind;
    btn.setAttribute('aria-pressed', String(!eraseMode && a.key === active?.key));
    btn.innerHTML = `<span class="pick__dot"></span><span class="pick__label">${escapeHtml(a.label)}</span>`;
    btn.addEventListener('click', () => pickActivity(a));
    picker.appendChild(btn);
  }

  const erase = document.createElement('button');
  erase.type = 'button';
  erase.className = 'pick pick--erase';
  erase.setAttribute('aria-pressed', String(eraseMode));
  erase.innerHTML = '<span class="pick__dot"></span><span class="pick__label">Erase</span>';
  erase.addEventListener('click', () => {
    eraseMode = !eraseMode;
    if (!eraseMode) brushKey = state.settings.brush || 'self_study';
    renderPicker();
    updateGridHint();
  });
  picker.appendChild(erase);
}

/**
 * Choose the activity the brush holds.
 *
 * If a block is picked, the activity goes to that block as well — one click
 * changes what the block says and what the next drag will paint.
 */
function pickActivity(a) {
  eraseMode = false;
  brushKey = a.key;
  state.settings.brush = a.key;
  save(state);

  if (selectedId) {
    const b = blocks().find(x => x.id === selectedId);
    if (b && b.key !== a.key) {
      remember();
      const next = blocks().map(x => (x.id === b.id
        ? { ...x, key: a.key, label: a.label, kind: a.kind }
        : x));
      current.blocks = mergeBlocks(next);
      selectedId = '';
      commit();
      return;
    }
  }
  renderPicker();
  updateGridHint();
}

function updateGridHint() {
  const hint = $('gridHint');
  if (!hint) return;
  if (eraseMode) { hint.textContent = 'Erasing — drag across the squares you want to clear.'; return; }
  const a = brushActivity();
  hint.textContent = a
    ? `Drag across the grid to fill every square you cross with ${a.label.toLowerCase()}.`
    : 'Pick an activity, then drag across the grid.';
}

/** What is running right now, and what comes after it. */
function renderNow() {
  const bar = el.planNow;
  if (!bar) return;
  const isToday = currentDate === dateKey(Date.now());
  const mins = minutesOfDay();
  const { current: cur, next } = dayProgress(blocks(), mins, isToday);

  if (!blocks().length) {
    bar.hidden = true;
    if (el.planStart) el.planStart.disabled = true;
    return;
  }
  bar.hidden = false;
  if (el.planStart) el.planStart.disabled = !(cur || next);

  const label = cur ? 'Now' : (isToday ? 'Next up' : 'Starts');
  const value = cur || next;
  bar.innerHTML = [
    `<span class="nowbar__label">${escapeHtml(label)}</span>`,
    `<span class="nowbar__value">${value ? escapeHtml(value.label) : '—'}</span>`,
    value ? `<span class="nowbar__time">${escapeHtml(blockRangeLabel(value))}</span>` : '',
  ].join('');
}

/* ── tasks ────────────────────────────────────────────────── */

function renderTasks() {
  const list = el.planTasks;
  if (!list) return;
  list.innerHTML = '';

  const all = tasks();
  const done = all.filter(t => t.done).length;
  if (el.planTaskCount) el.planTaskCount.textContent = all.length ? `· ${done}/${all.length}` : '';

  if (!all.length) {
    list.innerHTML = '<p class="empty">No tasks for this day yet.</p>';
    return;
  }

  // Tasks are grouped by their stage, the way the study list is grouped by
  // subject — it makes a long list readable at a glance.
  const groups = new Map();
  for (const t of all) {
    const name = t.stage || 'General';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(t);
  }

  for (const [stage, items] of groups) {
    const section = document.createElement('section');
    section.className = 'taskgroup';

    const head = document.createElement('div');
    head.className = 'taskgroup__head';
    const groupDone = items.filter(t => t.done).length;
    head.innerHTML = `<span class="taskgroup__name">${escapeHtml(stage)}</span><span class="taskgroup__count">${groupDone}/${items.length}</span>`;
    section.appendChild(head);

    for (const t of items) section.appendChild(taskRow(t));
    list.appendChild(section);
  }
}

function taskRow(t) {
  const row = document.createElement('div');
  row.className = 'taskrow';
  row.dataset.done = t.done ? 'true' : 'false';

  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'taskcheck';
  check.setAttribute('aria-label', t.done ? `Mark "${t.text}" as not done` : `Mark "${t.text}" as done`);
  check.innerHTML = t.done ? '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>' : '';
  check.addEventListener('click', () => {
    remember();
    current.tasks = tasks().map(x => (x.id === t.id ? { ...x, done: !x.done } : x));
    commit();
  });

  const text = document.createElement('span');
  text.className = 'taskrow__text';
  text.textContent = t.text;

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'icon-btn icon-btn--sm';
  del.setAttribute('aria-label', `Delete ${t.text}`);
  del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  del.addEventListener('click', () => {
    remember();
    current.tasks = tasks().filter(x => x.id !== t.id);
    commit();
  });

  row.append(check, text, del);
  return row;
}

/* ── the grid: painting, moving, resizing ─────────────────── */

/**
 * Which square of the day sits under the pointer.
 *
 * The day is two columns of twelve hours. A column is found by looking for
 * the track that actually holds the pointer — checked in both directions, so
 * the stacked layout on a narrow screen works as well as the side-by-side one
 * — and then falling back to the hour labels beside it, and finally to the
 * nearest track of all.
 *
 * @returns {number} a slot from 0 to 47, or -1 when the pointer is nowhere near
 */
function slotFromPoint(x, y) {
  let col = -1;
  let row = 0;

  // The pointer is over a track.
  for (let c = 0; c < COLS; c += 1) {
    const r = el.planTracks[c]?.getBoundingClientRect();
    if (!r || !r.height) continue;
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
      return c * HALF + rowIn(r, y);
    }
  }

  // The pointer is over the hour labels beside a track.
  for (let c = 0; c < COLS; c += 1) {
    const r = el.planGutters[c]?.getBoundingClientRect();
    if (!r || !r.height) continue;
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
      return c * HALF + rowIn(r, y);
    }
  }

  // The pointer is off the grid — use the closest track. The horizontal
  // distance decides (so the right column wins however far down the pointer
  // is), and the vertical one only breaks ties in the stacked layout.
  let best = Infinity;
  for (let c = 0; c < COLS; c += 1) {
    const r = el.planTracks[c]?.getBoundingClientRect();
    if (!r || !r.height) continue;
    const dx = x < r.left ? r.left - x : (x > r.right ? x - r.right : 0);
    const dy = y < r.top ? r.top - y : (y > r.bottom ? y - r.bottom : 0);
    const d = dx * 1e4 + dy;
    if (d < best) { best = d; col = c; row = rowIn(r, y); }
  }
  if (col < 0) return -1;
  return col * HALF + row;
}

/** The row of a track a vertical position falls on. */
function rowIn(rect, y) {
  return clamp(Math.floor((y - rect.top) / (rect.height / HALF)), 0, HALF - 1);
}

/** Is the pointer still over the grid (or close enough to it)? */
function overGrid(x, y) {
  const grid = el.planGrid;
  if (!grid) return false;
  const r = grid.getBoundingClientRect();
  return x >= r.left - LEAVE_MARGIN && x <= r.right + LEAVE_MARGIN
    && y >= r.top - LEAVE_MARGIN && y <= r.bottom + LEAVE_MARGIN;
}

/**
 * Paint the range the pointer is crossing.
 *
 * The range is always painted from the blocks the day started the drag with,
 * so dragging back and forth lands on the same result every time.
 */
function paintRangeTo(fromSlot, toSlot) {
  if (!drag) return;
  const activity = brushActivity();
  current.blocks = paintRange(drag.base, fromSlot, toSlot, activity);
  renderGrid();
  renderHeader();
}

function onPointerDown(e) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;

  const slot = slotFromPoint(e.clientX, e.clientY);
  if (slot < 0) return;

  const handle = e.target.closest('[data-handle]');
  const blockEl = e.target.closest('.grid__block');

  if (handle && blockEl) {
    const b = blocks().find(x => x.id === blockEl.dataset.id);
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    if (handle.dataset.handle === 'move') {
      drag = { mode: 'move', blockId: b.id, base: blocks(), grab: slot * SLOT_MIN - b.startMin, last: null };
    } else {
      drag = { mode: 'resize', blockId: b.id, edge: handle.dataset.handle, base: blocks(), last: null };
    }
    capture(e);
    return;
  }

  e.preventDefault();
  selectedId = '';

  if (blockEl) {
    // A press on a block may turn into a drag that repaints it. If it never
    // moves, it is a click and the block gets picked instead.
    drag = { mode: 'maybe', anchorSlot: slot, currentSlot: slot, base: blocks(), blockId: blockEl.dataset.id, moved: false };
  } else {
    drag = { mode: 'paint', anchorSlot: slot, currentSlot: slot, base: blocks(), moved: false };
    paintRangeTo(slot, slot);
  }
  capture(e);
}

function capture(e) {
  try { el.planGrid.setPointerCapture?.(e.pointerId); } catch { /* not supported */ }
}

function onPointerMove(e) {
  if (!drag) return;
  if (!overGrid(e.clientX, e.clientY)) { cancelDrag(); return; }

  const slot = slotFromPoint(e.clientX, e.clientY);
  if (slot < 0) return;

  if (drag.mode === 'maybe') {
    if (slot === drag.anchorSlot) return;
    drag.mode = 'paint';
    drag.moved = true;
    drag.currentSlot = slot;
    paintRangeTo(drag.anchorSlot, slot);
    return;
  }

  if (drag.mode === 'paint') {
    if (slot === drag.currentSlot) return;
    drag.currentSlot = slot;
    paintRangeTo(drag.anchorSlot, slot);
    return;
  }

  if (drag.mode === 'move') {
    const b = drag.base.find(x => x.id === drag.blockId);
    if (!b) return;
    const len = b.endMin - b.startMin;
    const start = clamp(slot * SLOT_MIN - drag.grab, 0, DAY_MIN - len);
    const snapped = Math.round(start / SLOT_MIN) * SLOT_MIN;
    if (snapped === drag.last) return;
    drag.last = snapped;
    current.blocks = moveBlock(drag.base, drag.blockId, snapped);
    renderGrid();
    renderHeader();
    return;
  }

  if (drag.mode === 'resize') {
    const b = drag.base.find(x => x.id === drag.blockId);
    if (!b) return;
    const minute = slot * SLOT_MIN;
    if (minute === drag.last) return;
    drag.last = minute;
    current.blocks = resizeBlockTo(drag.base, drag.blockId, drag.edge, minute);
    renderGrid();
    renderHeader();
  }
}

function onPointerUp(e) {
  if (!drag) return;
  const d = drag;
  drag = null;
  try { el.planGrid.releasePointerCapture?.(e.pointerId); } catch { /* fine */ }

  if (d.mode === 'maybe') {
    // A click, not a drag — pick the block so it can be edited.
    selectedId = d.blockId;
    renderGrid();
    renderInspector();
    return;
  }

  // Nothing changed — do not litter the history with empty steps.
  const before = JSON.stringify(d.base);
  const after = JSON.stringify(blocks());
  if (before === after) { renderGrid(); return; }

  remember(d.base);
  current.blocks = mergeBlocks(blocks());
  commit();
}

function cancelDrag() {
  if (!drag) return;
  const d = drag;
  drag = null;
  current.blocks = d.base;
  renderGrid();
  renderHeader();
}

/* ── dates ────────────────────────────────────────────────── */

function goToDate(key) {
  currentDate = key;
  current = getPlan(state, key);
  selectedId = '';
  drag = null;
  render();
}

/* ── editing a picked block ───────────────────────────────── */

function actOnBlock(action) {
  const b = blocks().find(x => x.id === selectedId);
  if (!b) return;

  if (action === 'close') {
    selectedId = '';
    renderGrid();
    renderInspector();
    return;
  }

  let next = blocks();
  if (action === 'delete') {
    next = removeBlock(next, b.id);
    selectedId = '';
  } else if (action === 'earlier') {
    next = moveBlock(next, b.id, b.startMin - SLOT_MIN);
  } else if (action === 'later') {
    next = moveBlock(next, b.id, b.startMin + SLOT_MIN);
  } else if (action === 'shorter') {
    next = resizeBlockTo(next, b.id, 'end', b.endMin - SLOT_MIN);
  } else if (action === 'longer') {
    next = resizeBlockTo(next, b.id, 'end', b.endMin + SLOT_MIN);
  } else {
    return;
  }

  // A block already at the edge of the day cannot move any further.
  if (JSON.stringify(next) === JSON.stringify(blocks())) return;

  remember();
  current.blocks = next;
  commit();
}

/* ── events ───────────────────────────────────────────────── */

function bindEvents() {
  el.planPrev?.addEventListener('click', () => goToDate(shiftKey(currentDate, -1)));
  el.planNext?.addEventListener('click', () => goToDate(shiftKey(currentDate, 1)));
  el.planToday?.addEventListener('click', () => goToDate(dateKey(Date.now())));

  el.planUndo?.addEventListener('click', undo);
  el.planRedo?.addEventListener('click', redo);

  // The grid: press, drag, fill.
  el.planGrid?.addEventListener('pointerdown', onPointerDown);
  el.planGrid?.addEventListener('pointermove', onPointerMove);
  el.planGrid?.addEventListener('pointerup', onPointerUp);
  el.planGrid?.addEventListener('pointercancel', cancelDrag);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', cancelDrag);

  // Right-click on a block clears it.
  el.planGrid?.addEventListener('contextmenu', (e) => {
    const blockEl = e.target.closest('.grid__block');
    if (!blockEl) return;
    e.preventDefault();
    const b = blocks().find(x => x.id === blockEl.dataset.id);
    if (!b) return;
    remember();
    current.blocks = removeBlock(blocks(), b.id);
    if (selectedId === b.id) selectedId = '';
    commit();
  });

  // The inspector under the grid.
  el.planInspector?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    actOnBlock(btn.dataset.act);
  });

  el.planTaskForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = el.planTaskInput.value.trim();
    if (!text) return;
    const stage = el.planTaskStage?.value || '';
    remember();
    current.tasks = [...tasks(), { id: uid('t'), text: text.slice(0, 120), stage, done: false, createdAt: Date.now() }];
    el.planTaskInput.value = '';
    commit();
  });

  el.planAddActivity?.addEventListener('click', () => {
    const name = window.prompt('Name this activity');
    if (!name || !name.trim()) return;
    const label = name.trim().slice(0, 40);
    const key = `custom:${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${Date.now().toString(36).slice(-4)}`;
    state.activities = [...state.activities, { key, label, kind: 'study' }];
    state.settings.brush = key;
    save(state);
    brushKey = key;
    eraseMode = false;
    state = load();
    render();
    showToast(`Added "${label}"`);
  });

  el.planClear?.addEventListener('click', () => {
    if (!blocks().length && !tasks().length) { showToast('Nothing to clear'); return; }
    if (!window.confirm(`Clear the plan for ${labelDate(currentDate, { month: 'long', day: 'numeric' })}?`)) return;
    remember();
    current = { ...current, blocks: [], tasks: [], imported: null, done: {} };
    selectedId = '';
    commit();
  });

  el.planCopy?.addEventListener('click', () => openCopyDialog());
  el.copyClose?.addEventListener('click', () => el.copyDialog?.close?.());
  el.copyCancel?.addEventListener('click', () => el.copyDialog?.close?.());
  el.copyOptions?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-copy-from]');
    if (!btn) return;
    copyDay(btn.dataset.copyFrom);
  });

  el.planStart?.addEventListener('click', () => continueTimetable(currentDate));

  // Importing a timetable: the button, and dropping a PDF anywhere.
  el.planImport?.addEventListener('click', () => el.planImportFile?.click());
  el.planImportFile?.addEventListener('change', async () => {
    const file = el.planImportFile.files?.[0];
    el.planImportFile.value = '';
    if (file) await runImport(file);
  });

  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    dragDepth += 1;
    if (el.dropOverlay) el.dropOverlay.hidden = false;
  });
  window.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth && el.dropOverlay) el.dropOverlay.hidden = true;
  });
  window.addEventListener('drop', async (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    dragDepth = 0;
    if (el.dropOverlay) el.dropOverlay.hidden = true;
    await runImport(e.dataTransfer.files[0]);
  });

  el.planSaveTimer?.addEventListener('click', () => {
    if (!blocks().length) { showToast('Nothing to save'); return; }
    savePlanForTimer(state, current, current.imported?.label || labelDate(currentDate, { weekday: 'long', month: 'long', day: 'numeric' }));
    saveNow(state);
    showToast('Saved to timer');
  });

  el.planPrint?.addEventListener('click', openPrintDialog);

  el.printClose?.addEventListener('click', () => el.printDialog?.close());
  el.printCancel?.addEventListener('click', () => el.printDialog?.close());
  el.planDownloadPdf?.addEventListener('click', () => { downloadPdf(); });
  el.printGo?.addEventListener('click', () => {
    if (el.printDialog?.dataset.pdf === '1') {
      el.printDialog.dataset.pdfGo = '1';
      el.printDialog.close();
      return;
    }
    el.printDialog?.close();
    printPlan();
  });

  el.printDialog?.addEventListener('change', (e) => {
    const input = e.target;
    if (!(input instanceof HTMLInputElement) || !input.name.startsWith('print')) return;
    if (input.name === 'printTheme') printOpts.theme = input.value === 'dark' ? 'dark' : 'light';
    if (input.name === 'printColour') printOpts.colour = input.value === 'grey' ? 'grey' : 'colour';
    if (input.name === 'printLayout') printOpts.layout = input.value === 'zen' ? 'zen' : 'full';

    state.settings.print = { ...printOpts };
    save(state);
    renderPrintDoc();
    renderPrintPreview();
    updatePrintHint();
  });

  window.addEventListener('beforeprint', () => {
    renderPrintDoc();
    document.documentElement.dataset.printTheme = printOpts.theme;
  });
  window.addEventListener('afterprint', () => {
    delete document.documentElement.dataset.printTheme;
  });

  el.planThemeBtn?.addEventListener('click', () => {
    const html = document.documentElement;
    const next = html.dataset.theme === 'graphite' ? 'void' : 'graphite';
    html.dataset.theme = next;
    state.settings.theme = next;
    save(state);
    showToast(next === 'graphite' ? 'Graphite theme' : 'Void theme');
  });

  window.addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    if (typing) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
      return;
    }
    if (e.key === 'Escape') {
      if (drag) { cancelDrag(); return; }
      if (selectedId) { selectedId = ''; renderGrid(); renderInspector(); }
    }
  });

  setInterval(updateRuntimeChip, 30000);
}

/* ── import, copy, hand over, export ──────────────────────── */

async function importCadenceJson(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result);
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object') throw new Error('bad');
        if (Array.isArray(parsed.sessions)) {
          state.settings = sanitizeSettings(parsed.settings);
          state.sessions = sanitizeSessions(parsed.sessions);
          state.counters = {
            focus: Number(parsed.counters?.focus) || 0,
            break: Number(parsed.counters?.break) || 0,
          };
          state.plans = sanitizePlans(parsed.plans);
          state.activities = sanitizeActivities(parsed.activities);
          if (Array.isArray(parsed.saved)) state.saved = parsed.saved;
          saveNow(state);
          showToast('Cadence data imported');
          resolve({ type: 'store' });
          return;
        }
        if (parsed.plans && typeof parsed.plans === 'object') {
          state.plans = sanitizePlans(parsed.plans);
          if (Array.isArray(parsed.activities)) state.activities = sanitizeActivities(parsed.activities);
          saveNow(state);
          showToast('Plans imported');
          resolve({ type: 'plans' });
          return;
        }
        if (parsed.type === 'cadence-plan' && parsed.plan) {
          const date = parsed.date && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ? parsed.date : currentDate;
          const plan = sanitizePlan(parsed.plan, date);
          if (plan.blocks.length || plan.tasks.length) {
            setPlan(state, date, plan);
            currentDate = date;
            current = plan;
            selectedId = '';
            render();
            showToast(`Imported plan for ${date}`);
            resolve({ type: 'plan' });
            return;
          }
        }
        if (parsed.blocks || parsed.date) {
          const date = parsed.date && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ? parsed.date : currentDate;
          const plan = sanitizePlan(parsed, date);
          if (plan.blocks.length || plan.tasks.length) {
            setPlan(state, date, plan);
            currentDate = date;
            current = plan;
            selectedId = '';
            render();
            showToast(`Imported plan for ${date}`);
            resolve({ type: 'plan' });
            return;
          }
        }
        throw new Error('bad');
      } catch (e) {
        reject(e);
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

async function tryImportCadencePdf(buffer) {
  try {
    const bytes = new Uint8Array(buffer);
    let text = '';
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (b >= 32 && b < 127) text += String.fromCharCode(b);
      else if (b === 10 || b === 13) text += '\n';
      else text += ' ';
    }
    const m = text.match(/\{"type":"cadence-plan"[^{}]*\}/);
    if (m) {
      const parsed = JSON.parse(m[0]);
      if (parsed.plan) {
        const date = parsed.date && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ? parsed.date : currentDate;
        const plan = sanitizePlan(parsed.plan, date);
        if (plan.blocks.length || plan.tasks.length) {
          setPlan(state, date, plan);
          currentDate = date;
          current = plan;
          selectedId = '';
          render();
          showToast(`Imported Cadence plan for ${date}`);
          return true;
        }
      }
    }
  } catch {}
  return false;
}

async function runImport(file) {
  try {
    if (file.type === 'application/json' || file.name.toLowerCase().endsWith('.json')) {
      await importCadenceJson(file);
      state = load();
      current = getPlan(state, currentDate);
      render();
      return;
    }
    if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
      const buffer = await file.arrayBuffer();
      if (await tryImportCadencePdf(buffer)) {
        state = load();
        current = getPlan(state, currentDate);
        render();
        return;
      }
      try {
        const result = await importTimetable(state, file);
        state = load();
        currentDate = result.date;
        current = getPlan(state, currentDate);
        selectedId = '';
        render();
        showToast(`Imported ${result.blocks} blocks · ${result.label}`);
        return;
      } catch (err) {
        showToast(importErrorMessage(err));
        return;
      }
    }
    showToast('Unsupported file type');
  } catch (err) {
    showToast(importErrorMessage(err));
  }
}

function openCopyDialog() {
  const today = dateKey(Date.now());
  const options = [
    { key: shiftKey(currentDate, -1), label: 'Previous day' },
    { key: shiftKey(currentDate, -7), label: 'Last week' },
    { key: today, label: 'Today' },
  ].filter(o => o.key !== currentDate);
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
  remember();
  current = {
    ...current,
    blocks: from.blocks.map(b => ({ ...b, id: uid('b') })),
    imported: from.imported ? { ...from.imported } : null,
    done: {},
  };
  selectedId = '';
  el.copyDialog?.close?.();
  commit();
  showToast('Plan copied');
}

function continueTimetable(date = dateKey(Date.now())) {
  const p = date === currentDate ? current : getPlan(state, date);
  if (!p.blocks.length) { showToast('Nothing is planned for that day'); return; }
  const isToday = date === dateKey(Date.now());
  const mins = minutesOfDay();
  const { current: cur, next } = dayProgress(p.blocks, mins, isToday);
  const block = cur || next;
  if (!block) { showToast('That day is done — nothing left to run'); return; }
  let remaining = (block.endMin - block.startMin) * 60000;
  if (cur && isToday) {
    const endTs = Date.now() - (mins * 60000) + (block.endMin * 60000);
    remaining = Math.max(1000, endTs - Date.now());
  }
  const kind = block.kind === 'rest' ? 'break' : 'focus';
  handOverToClock({ subject: block.label, sessionId: block.id, target: remaining, kind, date });
  window.location.href = './clock.html';
}

/* ── go ───────────────────────────────────────────────────── */

function init() {
  buildGutters();
  bindEvents();
  render();

  // Coming back to the page — from the clock, another tab or the background —
  // the store may have moved on. Re-read it, but never in the middle of a drag.
  const refresh = () => {
    if (drag) return;
    state = load();
    current = getPlan(state, currentDate);
    render();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });
  window.addEventListener('focus', refresh);
}

init();
