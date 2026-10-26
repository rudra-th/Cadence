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

import { load, saveNow, saveKeys, saveKeysNow, persistFailed, getPlan, setPlan, savePlanForTimer, storeErrorNotice, sanitizeSettings, sanitizeSessions, sanitizePlans, sanitizeActivities, sanitizeSavedPlans } from './store.js';
import {
  SLOT_MIN, DAY_MIN, activityMap, toneOf, ACTIVITIES,
  paintRange, removeBlock, mergeBlocks, moveBlock, resizeBlockTo,
  planSummary, blockRangeLabel, dayProgress,
} from './plan.js';
import { dateKey, shiftKey, labelDate, clockLabel, humanDuration, minutesOfDay, uid, clamp } from './util.js';
import { importTimetable, importErrorMessage } from './timetable-import.js';
import { buildPlanPrint } from './printplan.js';
import { handOverToClock, runningSession } from './runtime.js';

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
let focusedId = '';           // the block the keyboard is on (roving tabindex)
let drag = null;              // the gesture in progress, if any
let history = [];             // undo
let future = [];              // redo

/* Undo survives a reload: the last few snapshots live in localStorage under
   their own key, so a mis-click followed by an accidental refresh is not the
   end of the day. */
const UNDO_KEY = 'cadence.undo.v1';
const UNDO_KEEP = 20;

function writeUndo() {
  try {
    localStorage.setItem(UNDO_KEY, JSON.stringify({ entries: history.slice(-UNDO_KEEP) }));
  } catch { /* quota — undo simply stays memory-only */ }
}

function readUndo() {
  try {
    const saved = JSON.parse(localStorage.getItem(UNDO_KEY) || 'null');
    if (saved && Array.isArray(saved.entries)) history = saved.entries.slice(-UNDO_KEEP);
  } catch { /* unreadable — start with an empty stack */ }
}

/* A finger is not a mouse: the timetable paints on tap and scrolls on drag,
   so the hint has to say so. */
const COARSE_POINTER = window.matchMedia?.('(pointer: coarse)').matches ?? false;

/* The brush lock is the touch answer to dragging: while it is on, the grid
   owns every gesture, so a finger can paint a whole afternoon in one stroke
   and the page auto-scrolls at the edges. While it is off, the page scrolls
   normally and only taps paint.
   It starts ON on touch devices. With pan-y the browser claims any finger
   that drifts a few pixels, so a tap meant to add an activity would turn
   into a small page scroll and paint nothing — the lock makes the paint
   win, and the same toggle hands scrolling back when it is turned off. */
let brushLock = COARSE_POINTER;

/* Last-used print style, remembered in the store. */
let printOpts = { ...state.settings.print };

const $ = (id) => document.getElementById(id);

const el = {
  planPrev: $('planPrev'),
  planNext: $('planNext'),
  planToday: $('planToday'),
  planTitle: $('planTitle'),
  planSub: $('planSub'),
  planWeekStats: $('planWeekStats'),
  planWeek: $('planWeek'),
  planGrid: $('planGrid'),
  planTracks: [],
  planGutters: [],
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
  planAddBlock: $('planAddBlock'),
  planExport: $('planExport'),
  askDialog: $('askDialog'),
  askForm: $('askForm'),
  askInput: $('askInput'),
  askOk: $('askOk'),
  askCancel: $('askCancel'),
  askClose: $('askClose'),
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

function showToast(msg, opts) {
  if (!el.toast) return;
  el.toast.textContent = msg;
  // A toast can carry one action — "Undo", "Switch" — so the message does not
  // dead-end into Ctrl+Z knowledge the user may not have.
  showToast.act?.remove();
  showToast.act = null;
  if (opts?.action && opts?.onAction) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast__act';
    // Styled inline: the toast is shared markup and this button only exists
    // here, so it stays out of the stylesheet.
    btn.style.cssText = 'margin-left:12px;padding:0;background:none;border:0;color:inherit;font:inherit;font-weight:600;text-decoration:underline;text-underline-offset:2px;cursor:pointer;';
    btn.textContent = opts.action;
    btn.addEventListener('click', () => {
      clearTimeout(showToast.t);
      el.toast.hidden = true;
      opts.onAction();
    });
    el.toast.appendChild(btn);
    showToast.act = btn;
  }
  el.toast.hidden = false;
  clearTimeout(showToast.t);
  showToast.t = setTimeout(() => { el.toast.hidden = true; }, opts?.action ? 5000 : 1800);
}

/** Encode a string as base64 — PDF-safe (plain ASCII), so it survives extraction. */
function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Decode base64 back to the original string. */
function fromBase64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/** Read bytes as a printable-ASCII string — the layer the PDF bytes expose. */
function pdfLatin(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i];
    if (b >= 32 && b < 127) text += String.fromCharCode(b);
    else if (b === 9 || b === 10 || b === 13) text += '\n';
  }
  return text;
}

/** Find an ASCII byte sequence in a byte array. */
function findBytes(bytes, seq, from = 0) {
  outer: for (let i = Math.max(0, from); i <= bytes.length - seq.length; i += 1) {
    for (let j = 0; j < seq.length; j += 1) {
      if (bytes[i + j] !== seq[j]) continue outer;
    }
    return i;
  }
  return -1;
}

const STREAM = new TextEncoder().encode('stream');
const ENDSTREAM = new TextEncoder().encode('endstream');

/**
 * Decompress the FlateDecode streams inside a PDF.
 *
 * Browsers save PDFs with compressed content streams, so the JSON parked in a
 * printed sheet is invisible to a plain byte scan. Inflating every stream
 * gives the importer the same readable layer the Download PDF already has.
 *
 * Markers are located on the raw bytes — collapsing to text first would shift
 * every offset, because compressed data is full of non-ASCII bytes.
 */
async function inflatedPdfTexts(bytes) {
  const out = [];
  if (!bytes || bytes.length < 64) return out;
  const MAX = 12e6;
  let idx = 0;
  for (;;) {
    const s = findBytes(bytes, STREAM, idx);
    if (s < 0) break;
    let dataStart = s + STREAM.length;
    while (dataStart < bytes.length && (bytes[dataStart] === 13 || bytes[dataStart] === 10)) dataStart += 1;
    const e = findBytes(bytes, ENDSTREAM, dataStart);
    if (e < 0) break;
    idx = e + ENDSTREAM.length;
    const len = e - dataStart;
    if (len <= 0 || len > MAX) continue;
    const slice = bytes.subarray(dataStart, e);
    if (typeof DecompressionStream !== 'function') break;
    for (const enc of ['deflate', 'deflate-raw']) {
      try {
        const ds = new DecompressionStream(enc);
        const w = ds.writable.getWriter();
        const writing = w.write(slice).catch(() => {});
        w.close().catch(() => {});
        await writing;
        const chunks = [];
        for await (const c of ds.readable) chunks.push(c);
        const buf = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
        let at = 0;
        for (const c of chunks) { buf.set(c, at); at += c.length; }
        out.push(pdfLatin(buf));
        break;
      } catch { /* not this encoding — try the next */ }
    }
  }
  return out;
}

/**
 * Pull a Cadence plan payload out of one text layer.
 *
 * Three shapes are accepted: the tagged base64 block (current), the tagged
 * raw JSON (older exports), and a bare cadence-plan object (oldest).
 */
function planPayloadFromText(text) {
  // 1) tagged base64 — the current format
  let m = text.match(/CADENCE_V1:([A-Za-z0-9+/=]+)/);
  if (m) {
    try {
      const parsed = JSON.parse(fromBase64(m[1]));
      // Version guard: a v2 payload should fail loudly, not sanitise as v1.
      if (parsed.plan && (parsed.v == null || parsed.v === 1)) return parsed;
    } catch { /* fall through */ }
  }
  // 2) tagged raw JSON — older "Download PDF" exports
  let idx = text.indexOf('CADENCE_PLAN_DATA:');
  if (idx >= 0) idx = text.indexOf('{', idx);
  if (idx < 0) idx = text.indexOf('{"type":"cadence-plan"');
  if (idx < 0) idx = text.indexOf('cadence-plan') > 0 ? text.lastIndexOf('{', text.indexOf('cadence-plan')) : -1;
  if (idx >= 0) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = idx; i < text.length && i < idx + 200000; i += 1) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(text.slice(idx, i + 1));
            if (parsed.plan || parsed.blocks) return parsed;
          } catch { /* keep scanning */ }
          break;
        }
      }
    }
  }
  return null;
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
  writeUndo();
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
  writeUndo();
  future.push(snapshot());
  restore(entry);
  commit();
}

function redo() {
  const entry = future.pop();
  if (!entry) { showToast('Nothing to redo'); return; }
  history.push(snapshot());
  writeUndo();
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
  // setPlan writes the plan key immediately and merges the rest of the store
  // from the disk — a full-state write here would roll live timer sessions
  // back to the moment this tab was opened.
  setPlan(state, currentDate, current);
  if (persistFailed()) {
    showToast('Could not save — storage is full or blocked');
  } else {
    flashSaved();
  }
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
  renderStats();
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
  const isToday = currentDate === dateKey(Date.now());

  el.planTitle.textContent = labelDate(currentDate, { weekday: 'long', day: 'numeric', month: 'long' });

  if (el.planSub) {
    el.planSub.textContent = isToday ? 'Today' : '';
  } else {
    const el2 = document.getElementById('planSub');
    if (el2) el2.textContent = isToday ? 'Today' : '';
  }

  if (el.planUndo) el.planUndo.disabled = !history.length;
  if (el.planRedo) el.planRedo.disabled = !future.length;
}

/**
 * The numbers that describe the day.
 *
 * One renderer for one element — the header used to write five of them and the
 * week strip six, so the rail changed shape depending on which ran last.
 */
function renderStats() {
  if (!el.planWeekStats) return;
  const summary = planSummary(current);
  const fmt = (m) => (m >= 60 ? Math.floor(m / 60) + 'h' + (m % 60 ? (m % 60) + 'm' : '') : m ? m + 'm' : '0m');
  el.planWeekStats.innerHTML = `
    <div class="plan__stat"><span class="plan__stat-label">Blocks</span><span class="plan__stat-value">${summary.blocks}</span></div>
    <div class="plan__stat"><span class="plan__stat-label">Study</span><span class="plan__stat-value">${fmt(summary.studyMin)}</span></div>
    <div class="plan__stat"><span class="plan__stat-label">Rest</span><span class="plan__stat-value">${fmt(summary.restMin)}</span></div>
    <div class="plan__stat"><span class="plan__stat-label">Sleep</span><span class="plan__stat-value">${fmt(summary.sleepMin || 0)}</span></div>
    <div class="plan__stat"><span class="plan__stat-label">Free</span><span class="plan__stat-value">${fmt(summary.freeMin)}</span></div>
    <div class="plan__stat"><span class="plan__stat-label">Tasks</span><span class="plan__stat-value">${summary.tasksDone}/${summary.tasks}</span></div>
  `;
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
  const go = el.printGo;
  const oldLabel = go?.textContent;
  if (go) go.textContent = 'Download';
  let opened = true;
  try {
    if (!el.printDialog.open) el.printDialog.showModal();
  } catch {
    // Another dialog is already showing — the label comes back on the next
    // open, rather than leaving a pending close listener behind.
    opened = false;
  }
  if (!opened) {
    if (go) go.textContent = oldLabel || 'Print';
    return;
  }
  el.printDialog.dataset.pdf = '1';
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
  const url = new URL(src, location.href).href;
  // Remember failures so a failed load can be retried — a dead `<script>` tag
  // left in the document would silently satisfy this check forever.
  loadScriptOnce.failed = loadScriptOnce.failed || {};
  if (!loadScriptOnce.failed[url] && [...document.scripts].some(s => s.src === url)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => { loadScriptOnce.failed[url] = false; resolve(); };
    s.onerror = () => { loadScriptOnce.failed[url] = true; s.remove(); reject(new Error(`Could not load ${src}`)); };
    document.head.appendChild(s);
  });
}

let exportBusy = false;

async function exportPdf() {
  if (exportBusy) return;   // never run two writes over #printDoc at once
  exportBusy = true;
  try {
    await runPdfExport();
  } finally {
    exportBusy = false;
  }
}

async function runPdfExport() {
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
      // The plan travels inside the PDF as tagged base64 text, parked far off
      // the page: invisible in the viewer, but easy for the importer to find.
      const payload = toBase64(JSON.stringify({
        type: 'cadence-plan', v: 1, date: currentDate, plan: current, exportedAt: Date.now(),
      }));
      pdf.setFontSize(0.1);
      pdf.text('CADENCE_V1:' + payload, -1000, -1000);
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
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'weekday';
    if (key === currentDate) btn.setAttribute('aria-current', 'date');
    btn.dataset.has = pp.blocks.length ? 'true' : 'false';
    btn.dataset.today = key === today ? 'true' : 'false';
    btn.title = labelDate(key, { weekday: 'long', day: 'numeric', month: 'long' });
    btn.innerHTML = `<div class="weekday__left"><span class="weekday__name">${labelDate(key, { weekday: 'short' })}</span><span class="weekday__num">${key.slice(8)}</span></div><span class="weekday__dot"></span>`;
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

  // On a phone one square is ~13px tall — a one-square block cannot fit its
  // own name, so those blocks drop the label and keep the inspector.
  const slotH = el.planTracks[0] ? el.planTracks[0].getBoundingClientRect().height / HALF : 0;
  const tiny = slotH > 0 && slotH < 20;

  // Roving tabindex needs an entry point: with nothing focused, the first
  // block of the day holds the tab stop, so Tab can walk into the grid.
  if (!focusedId) {
    const sorted = [...blocks()].sort((a, b) => a.startMin - b.startMin);
    focusedId = sorted[0]?.id || '';
  }

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
        b.startMin >= col * COL_MIN, b.endMin <= (col + 1) * COL_MIN, tiny));
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
function blockEl(b, row, span, map, first, last, tiny) {
  const act = map.get(b.key);
  const elb = document.createElement('div');
  elb.className = 'grid__block';
  elb.dataset.id = b.id;
  elb.dataset.key = b.key;
  elb.dataset.kind = act?.kind || b.kind || 'study';
  elb.dataset.tone = String(toneOf(b.key));
  if (b.id === selectedId) elb.classList.add('is-selected');
  if (span < 2) elb.classList.add('is-short');
  if (tiny && span < 2) elb.classList.add('is-tiny');
  if (!first) elb.classList.add('is-continued');
  elb.style.setProperty('--row', String(row));
  elb.style.setProperty('--span', String(span));
  elb.title = `${b.label} · ${blockRangeLabel(b)}`;
  // Keyboard users get the grid too: one block holds the tab stop (roving
  // tabindex), arrows walk the day, Enter picks the block for the inspector.
  elb.tabIndex = b.id === focusedId ? 0 : -1;
  elb.setAttribute('role', 'button');
  elb.setAttribute('aria-label', `${b.label}, ${blockRangeLabel(b)}`);
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

/* The palette opens with the three things most days are made of, so the
   first chips on a phone are the ones people reach for; the rest scrolls
   after them. Erase is a tool, not an activity, so it lives with Add. */
const FIRST_UP = ['sleep', 'self_study', 'breaks'];

function renderPicker() {
  const picker = el.planPicker;
  if (!picker) return;
  picker.innerHTML = '';
  const map = activities();
  const active = brushActivity();

  const list = [];
  const seen = new Set();
  for (const a of map.values()) { if (!seen.has(a.key)) { seen.add(a.key); list.push(a); } }
  for (const a of ACTIVITIES) { if (!seen.has(a.key)) { seen.add(a.key); list.push(a); } }

  const first = [];
  for (const key of FIRST_UP) {
    const a = list.find(x => x.key === key);
    if (a) first.push(a);
  }
  const rest = list.filter(a => !FIRST_UP.includes(a.key));

  const activityButton = (a) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pick';
    btn.dataset.tone = String(toneOf(a.key));
    btn.dataset.kind = a.kind;
    btn.setAttribute('aria-pressed', String(!eraseMode && a.key === active?.key));
    btn.innerHTML = `<span class="pick__dot"></span><span class="pick__label">${escapeHtml(a.label)}</span>`;
    btn.addEventListener('click', () => pickActivity(a));
    return btn;
  };

  for (const a of first) picker.appendChild(activityButton(a));
  for (const a of rest) picker.appendChild(activityButton(a));

  // Erase sits beside Add so it never reads as one more thing to paint with.
  const slot = document.getElementById('planEraseSlot');
  if (!slot) return;
  slot.innerHTML = '';
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
  slot.appendChild(erase);

  // The brush lock is a touch-only tool: with a mouse, dragging already paints.
  if (COARSE_POINTER) {
    const lock = document.createElement('button');
    lock.type = 'button';
    lock.className = 'pick pick--lock' + (brushLock ? ' is-on' : '');
    lock.id = 'planBrushLock';
    lock.setAttribute('aria-pressed', String(brushLock));
    lock.title = 'Paint by dragging your finger — page scrolling pauses while this is on';
    lock.innerHTML = `<span class="pick__dot"></span><span class="pick__label">Brush ${brushLock ? 'on' : 'off'}</span>`;
    lock.addEventListener('click', () => {
      brushLock = !brushLock;
      document.body.classList.toggle('paint-lock', brushLock);
      renderPicker();
      updateGridHint();
      showToast(brushLock
        ? 'Brush on — drag to paint, page scrolls again when it is off'
        : 'Brush off — taps paint, drags scroll');
    });
    slot.appendChild(lock);
  }
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
  saveKeys(state, ['settings']);

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
  if (eraseMode) {
    hint.textContent = COARSE_POINTER
      ? 'Erasing — tap the squares you want to clear.'
      : 'Erasing — drag across the squares you want to clear.';
    return;
  }
  const a = brushActivity();
  if (!a) {
    hint.textContent = COARSE_POINTER
      ? 'Pick an activity, then tap a square.'
      : 'Pick an activity, then drag across the grid.';
    return;
  }
  hint.textContent = COARSE_POINTER
    ? (brushLock
      ? `Brush on — drag across the grid to paint ${a.label.toLowerCase()}. Tap a block to edit it.`
      : `Tap a square to paint ${a.label.toLowerCase()}, or turn Brush on to drag. Tap a block to edit it.`)
    : `Drag across the grid to fill every square you cross with ${a.label.toLowerCase()}.`;
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
    // The button stays live even with an empty day — clicking it explains
    // what to do next, which beats a silently dead primary action.
    if (el.planStart) el.planStart.disabled = false;
    return;
  }
  bar.hidden = false;
  if (el.planStart) el.planStart.disabled = false;

  const label = cur ? 'Now' : (isToday ? 'Next up' : 'Starts');
  const value = cur || next;

  // Nothing running, nothing next — the pill has nothing to say, so it says
  // nothing instead of printing two dashes in the middle of the card.
  if (!value) {
    bar.hidden = true;
    return;
  }

  const nowLabel = document.getElementById('nowLabel');
  const nowValue = document.getElementById('nowValue');
  const nowTime = document.getElementById('nowTime');
  
  if (nowLabel) nowLabel.textContent = label;
  if (nowValue) nowValue.textContent = value.label;
  if (nowTime) nowTime.textContent = blockRangeLabel(value);
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
function paintRangeTo(fromSlot, toSlot, d) {
  d = d || drag;
  if (!d) return;
  const activity = brushActivity();
  current.blocks = paintRange(d.base, fromSlot, toSlot, activity);
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
    bindDragWindow();
    return;
  }

  e.preventDefault();
  selectedId = '';

  if (blockEl) {
    // A press on a block may turn into a drag that repaints it. If it never
    // moves, it is a click and the block gets picked instead.
    drag = { mode: 'maybe', anchorSlot: slot, currentSlot: slot, base: blocks(), blockId: blockEl.dataset.id, moved: false };
  } else if (e.pointerType === 'touch' && !brushLock) {
    // A finger that meant to scroll the page starts here too, so the first
    // paint waits for the lift. A real tap lifts on the same square and
    // paints it; a scroll moves and is handed back to the browser.
    drag = { mode: 'paint', anchorSlot: slot, currentSlot: slot, base: blocks(), moved: false, deferred: true, x: e.clientX, y: e.clientY };
  } else {
    drag = { mode: 'paint', anchorSlot: slot, currentSlot: slot, base: blocks(), moved: false };
    paintRangeTo(slot, slot);
  }
  capture(e);
  bindDragWindow();
}

/* The window listeners exist only while a drag is alive — a permanent
   pointermove on the window is work on every mouse move for nothing. */
function bindDragWindow() {
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', cancelDrag);
}

function unbindDragWindow() {
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  window.removeEventListener('pointercancel', cancelDrag);
}

/** Nudge the page toward the pointer when a touch-paint reaches an edge. */
function autoScrollOnEdge(y) {
  const margin = 72;
  const step = 14;
  if (y < margin) window.scrollBy(0, -step);
  else if (y > window.innerHeight - margin - 16) window.scrollBy(0, step);
}

/** How far the pointer has drifted from where the gesture began. */
function dragTravel(e) {
  if (!drag || drag.x === undefined) return 0;
  return Math.hypot(e.clientX - drag.x, e.clientY - drag.y);
}

function capture(e) {
  try { el.planGrid.setPointerCapture?.(e.pointerId); } catch { /* not supported */ }
}

function onPointerMove(e) {
  if (!drag) return;
  if (!overGrid(e.clientX, e.clientY)) { cancelDrag(); return; }

  // A waiting touch: past a small slop it is a scroll, not a paint — give the
  // gesture back to the browser instead of leaving a painted slot behind.
  if (drag.deferred && dragTravel(e) > 10) { drag = null; unbindDragWindow(); return; }
  if (drag.deferred) return;

  // With the brush lock on, a finger painting past the edge of the screen
  // carries the page with it, so long blocks can run past the fold.
  if (e.pointerType === 'touch' && brushLock) autoScrollOnEdge(e.clientY);

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
  unbindDragWindow();
  try { el.planGrid.releasePointerCapture?.(e.pointerId); } catch { /* fine */ }

  if (d.mode === 'maybe') {
    // A click, not a drag — pick the block so it can be edited.
    selectedId = d.blockId;
    focusedId = d.blockId;
    renderGrid();
    renderInspector();
    return;
  }

  if (d.deferred) {
    // The tap waited for this lift: paint the one square it landed on.
    // The drag record is passed along — it was detached above.
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 10) { renderGrid(); return; }
    paintRangeTo(d.anchorSlot, d.anchorSlot, d);
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
  unbindDragWindow();
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
    focusedId = '';
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

/* ── the keyboard on the grid ─────────────────────────────── */

/** Put the keyboard on one block: roving tabindex, then real focus. */
function focusBlock(id) {
  focusedId = id;
  const target = el.planGrid?.querySelector(`.grid__block[data-id="${CSS.escape(id)}"]`);
  if (!target) return;
  for (const b of el.planGrid.querySelectorAll('.grid__block')) {
    if (b !== target) b.tabIndex = -1;
  }
  target.tabIndex = 0;
  target.focus();
}

/** Walk the day in time order — the two columns read as one column here. */
function focusSiblingBlock(step) {
  const sorted = [...blocks()].sort((a, b) => a.startMin - b.startMin);
  if (!sorted.length) return;
  const i = sorted.findIndex(x => x.id === focusedId);
  const next = sorted[i < 0 ? 0 : clamp(i + step, 0, sorted.length - 1)];
  focusBlock(next.id);
}

/** Create a one-hour block in the first free hour, starting from "now". */
function addBlock() {
  const busy = blocks();
  const taken = (s, e) => busy.some(b => s < b.endMin && e > b.startMin);
  const isToday = currentDate === dateKey(Date.now());
  const from = isToday ? Math.ceil(minutesOfDay() / SLOT_MIN) * SLOT_MIN : 8 * 60;
  let start = -1;
  for (let s = from; s + 60 <= DAY_MIN; s += SLOT_MIN) if (!taken(s, s + 60)) { start = s; break; }
  if (start < 0) {
    for (let s = 0; s + 60 <= DAY_MIN; s += SLOT_MIN) if (!taken(s, s + 60)) { start = s; break; }
  }
  if (start < 0) { showToast('No free hour left in the day'); return; }
  const a = brushActivity() || { key: 'self_study', label: 'Self study', kind: 'study' };
  const nb = { id: uid('b'), key: a.key, label: a.label, kind: a.kind, startMin: start, endMin: start + 60 };
  remember();
  current.blocks = mergeBlocks([...busy, nb]);
  selectedId = nb.id;
  focusedId = nb.id;
  commit();
  focusBlock(nb.id);
}

/* ── events ───────────────────────────────────────────────── */

/**
 * The one small question this page asks in its own voice — a styled dialog
 * instead of a browser prompt, which banners the URL in an installed app.
 */
function askText({ title, sub, placeholder, ok }) {
  return new Promise((resolve) => {
    const d = el.askDialog;
    if (!d || typeof d.showModal !== 'function') {
      // No dialog support — the native prompt is the honest fallback.
      resolve(window.prompt(title));
      return;
    }
    $('askTitle').textContent = title;
    if ($('askSub')) $('askSub').textContent = sub || '';
    if (el.askOk) el.askOk.textContent = ok || 'OK';
    if (el.askInput) {
      el.askInput.value = '';
      el.askInput.placeholder = placeholder || '';
    }
    const onOk = (e) => {
      e.preventDefault();
      finish(el.askInput?.value ?? '');
    };
    const onCancel = () => finish(null);
    const onKey = (e) => { if (e.key === 'Escape') finish(null); };
    function finish(value) {
      el.askForm?.removeEventListener('submit', onOk);
      el.askCancel?.removeEventListener('click', onCancel);
      el.askClose?.removeEventListener('click', onCancel);
      d.removeEventListener('cancel', onKey);
      d.removeEventListener('close', onCloseEvent);
      if (d.open) d.close();
      resolve(value);
    }
    function onCloseEvent() { finish(null); }  // Escape / backdrop close paths
    el.askForm?.addEventListener('submit', onOk);
    el.askCancel?.addEventListener('click', onCancel);
    el.askClose?.addEventListener('click', onCancel);
    d.addEventListener('cancel', onKey);
    d.addEventListener('close', onCloseEvent);
    d.showModal();
    setTimeout(() => el.askInput?.focus(), 40);
  });
}

function bindEvents() {
  el.planPrev?.addEventListener('click', () => goToDate(shiftKey(currentDate, -1)));
  el.planNext?.addEventListener('click', () => goToDate(shiftKey(currentDate, 1)));
  el.planToday?.addEventListener('click', () => goToDate(dateKey(Date.now())));

  el.planUndo?.addEventListener('click', undo);
  el.planRedo?.addEventListener('click', redo);

  // The grid: press, drag, fill. The window-side listeners are attached only
  // while a drag is alive (bindDragWindow) — see onPointerDown.
  el.planGrid?.addEventListener('pointerdown', onPointerDown);
  el.planGrid?.addEventListener('pointermove', onPointerMove);
  el.planGrid?.addEventListener('pointerup', onPointerUp);
  el.planGrid?.addEventListener('pointercancel', cancelDrag);

  // Keyboard on the grid: arrows walk the blocks, Enter picks one for the
  // inspector, Delete removes it (with the same confirm a right-click gets).
  el.planGrid?.addEventListener('keydown', (e) => {
    const elb = e.target.closest?.('.grid__block');
    if (!elb) return;
    const b = blocks().find(x => x.id === elb.dataset.id);
    if (!b) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      selectedId = b.id;
      renderGrid();
      renderInspector();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      if (!window.confirm(`Delete "${b.label}" (${blockRangeLabel(b)})?`)) return;
      remember();
      current.blocks = removeBlock(blocks(), b.id);
      if (selectedId === b.id) selectedId = '';
      focusedId = '';
      commit();
      return;
    }
    const dir = (e.key === 'ArrowDown' || e.key === 'ArrowRight') ? 1
      : (e.key === 'ArrowUp' || e.key === 'ArrowLeft') ? -1 : 0;
    if (dir) { e.preventDefault(); focusSiblingBlock(dir); }
  });

  // Right-click on a block clears it — with a confirm, because an accidental
  // right-click should not cost a block without a word.
  el.planGrid?.addEventListener('contextmenu', (e) => {
    const blockEl = e.target.closest('.grid__block');
    if (!blockEl) return;
    e.preventDefault();
    const b = blocks().find(x => x.id === blockEl.dataset.id);
    if (!b) return;
    if (!window.confirm(`Delete "${b.label}" (${blockRangeLabel(b)})?`)) return;
    remember();
    current.blocks = removeBlock(blocks(), b.id);
    if (selectedId === b.id) selectedId = '';
    focusedId = '';
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

  el.planAddActivity?.addEventListener('click', async () => {
    const name = await askText({
      title: 'Name this activity',
      sub: 'It joins the palette and becomes the brush',
      placeholder: 'e.g. Physics revision',
      ok: 'Add',
    });
    if (!name || !name.trim()) return;
    const label = name.trim().slice(0, 40);
    const key = `custom:${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${Date.now().toString(36).slice(-4)}`;
    state.activities = [...state.activities, { key, label, kind: 'study' }];
    state.settings.brush = key;
    // Scoped write: the in-memory state already holds the new activity.
    // Re-loading from the disk here would race the debounced save and could
    // drop the new activity entirely.
    saveKeysNow(state, ['activities', 'settings']);
    brushKey = key;
    eraseMode = false;
    render();
    showToast(`Added "${label}"`);
  });

  el.planAddBlock?.addEventListener('click', addBlock);

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
  el.planExport?.addEventListener('click', exportJson);

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
    // Dragover must be canceled for the browser to even fire `drop` — leaving
    // it alone lets a link or an image navigate this tab away.
    e.preventDefault();
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth && el.dropOverlay) el.dropOverlay.hidden = true;
  });
  window.addEventListener('drop', async (e) => {
    // Always cancel the browser default — letting a link or an image through
    // would navigate this tab away from the planner.
    e.preventDefault();
    if (!e.dataTransfer?.files?.length) return;
    dragDepth = 0;
    if (el.dropOverlay) el.dropOverlay.hidden = true;
    await runImport(e.dataTransfer.files[0]);
  });

  el.planSaveTimer?.addEventListener('click', () => {
    if (!blocks().length) { showToast('Nothing to save'); return; }
    savePlanForTimer(state, current, current.imported?.label || labelDate(currentDate, { weekday: 'long', month: 'long', day: 'numeric' }));
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
    saveKeys(state, ['settings']);
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
    saveKeys(state, ['settings']);
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
          // This replaces the entire store — settings, sessions, counters,
          // plans. Ask before it is irreversible.
          if (!window.confirm('Import this file? It will replace all Cadence data on this device (sessions, plans, settings).')) {
            resolve({ type: 'cancel' });
            return;
          }
          state.settings = sanitizeSettings(parsed.settings);
          state.sessions = sanitizeSessions(parsed.sessions);
          state.counters = {
            focus: Number(parsed.counters?.focus) || 0,
            break: Number(parsed.counters?.break) || 0,
          };
          state.plans = sanitizePlans(parsed.plans);
          state.activities = sanitizeActivities(parsed.activities);
          if (Array.isArray(parsed.saved)) {
            state.saved = sanitizeSavedPlans(parsed.saved);
          }
          saveNow(state);
          showToast('Cadence data imported');
          resolve({ type: 'store' });
          return;
        }
        if (parsed.plans && typeof parsed.plans === 'object') {
          if (!window.confirm('Import plans? This replaces the plans currently stored for every date.')) {
            resolve({ type: 'cancel' });
            return;
          }
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
    const sources = [pdfLatin(bytes)];
    try {
      sources.push(...(await inflatedPdfTexts(bytes)));
    } catch { /* decompression unavailable — the raw layer still counts */ }

    for (const text of sources) {
      const parsed = planPayloadFromText(text);
      if (!parsed) continue;
      const planData = parsed.plan || parsed;
      const date = typeof parsed.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date)
        ? parsed.date
        : (typeof planData.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(planData.date) ? planData.date : currentDate);
      const plan = sanitizePlan(planData, date);
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
  } catch {}
  return false;
}

/** Does this PDF carry Cadence data at all (even if unreadable)? */
async function pdfIsCadence(buffer) {
  try {
    const bytes = new Uint8Array(buffer);
    const raw = pdfLatin(bytes);
    if (raw.includes('cadence-plan') || raw.includes('CADENCE_V1')) return true;
    for (const text of await inflatedPdfTexts(bytes)) {
      if (text.includes('cadence-plan') || text.includes('CADENCE_V1')) return true;
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
        // A PDF that carries Cadence data but failed to decode needs a
        // different message than a foreign timetable that simply has none.
        const cadence = await pdfIsCadence(buffer);
        showToast(cadence
          ? 'This Cadence PDF could not be read — try exporting it again.'
          : importErrorMessage(err));
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
  const existing = blocks();
  if (existing.length
    && !window.confirm(`Replace the ${existing.length} block${existing.length === 1 ? '' : 's'} already planned for ${labelDate(currentDate, { month: 'long', day: 'numeric' })}?`)) {
    return;
  }
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

/** Download the whole store as JSON — the same file the clock's Data tab
    writes, so either page can re-import it. The landing page promises this
    export next to the planner, so the planner owns it. */
function exportJson() {
  try {
    const payload = JSON.stringify({ exportedAt: new Date().toISOString(), ...state }, null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cadence-${dateKey(Date.now())}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    showToast('Data exported');
  } catch {
    showToast('Could not export — storage unavailable');
  }
}

function continueTimetable(date = dateKey(Date.now())) {
  const p = date === currentDate ? current : getPlan(state, date);
  if (!p.blocks.length) { showToast('Nothing planned yet — paint or import a day first'); return; }
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
  // The brush lock starts on for touch (see brushLock above) — the class must
  // be on <body> before the first gesture, because touch-action is only read
  // when a gesture begins.
  if (brushLock) document.body.classList.add('paint-lock');

  el.planTracks = [document.querySelector('.grid__track[data-col="0"]'), document.querySelector('.grid__track[data-col="1"]')];
  el.planGutters = [document.querySelector('.grid__gutter[data-col="0"]'), document.querySelector('.grid__gutter[data-col="1"]')];
  buildGutters();
  readUndo();
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

  // Another tab moved the store (the plan page and the clock are meant to be
  // open side by side) — follow it instead of stale-writing over it.
  window.addEventListener('cadence:store-external', () => { if (!drag) refresh(); });

  // The store fell back to defaults somewhere — say so, the user has a backup
  // under cadence.store.v1.bad and deserves to know. The notice can also
  // arrive as an event later (another tab, a focus refresh) — a good load
  // clears it, so nothing double-toasts.
  const corrupt = storeErrorNotice();
  if (corrupt) showToast(corrupt);
  window.addEventListener('cadence:store-corrupt', (e) => {
    showToast(e.detail?.message || 'Saved data could not be read — a backup was kept');
  });

  // The now-line and the "Today" pill are drawn once; a planner left open for
  // hours would keep showing this morning. Refresh gently, and when midnight
  // passes, offer the new day instead of silently editing the old one.
  let rolloverPrompted = false;
  setInterval(() => {
    if (drag || document.hidden) return;
    const today = dateKey(Date.now());
    if (today !== currentDate && !rolloverPrompted && current.blocks.length) {
      rolloverPrompted = true;
      showToast('A new day has started', {
        action: 'Switch',
        onAction: () => goToDate(today),
      });
    }
    renderGrid();
    renderNow();
    if (focusedId) {
      const back = el.planGrid?.querySelector(`.grid__block[data-id="${CSS.escape(focusedId)}"]`);
      back?.focus({ preventScroll: true });
    }
  }, 60000);
}

init();
