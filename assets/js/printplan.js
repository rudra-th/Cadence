/**
 * Cadence — the printed day.
 *
 * The plan page prints this, not the app. Three things the sheet can be:
 *
 *   • paper or ink   — a light sheet for paper, a dark one for screens;
 *   • colour or grey — activities can carry a hue or stay monochrome;
 *   • full or zen    — everything, or just the date, the strip and the day.
 *
 * It is plain HTML and CSS so the system print dialog can lay it out on A4,
 * and so "Save as PDF" in that dialog gives a real vector file with
 * selectable text. No library, no network.
 */

import { planSummary, blockRangeLabel, toneOf } from './plan.js';
import { clockLabel, humanDuration, labelDate } from './util.js';

/* ── little helpers ────────────────────────────────────────── */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ESCAPES[ch]);
}

/** 90 → '1h 30m' */
function dur(minutes) {
  return humanDuration(Math.max(0, minutes) * 60000);
}

/** A share of the whole day, the way a pie chart would read it. */
function pct(minutes) {
  return Math.round((Math.max(0, minutes) / 1440) * 100);
}

const CHECK = '<svg viewBox="0 0 12 12" aria-hidden="true">'
  + '<path d="M2.3 6.4 4.7 8.8 9.7 3.5" fill="none" stroke="currentColor" '
  + 'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/* ── colour ────────────────────────────────────────────────── */

/*
 * The app itself has no colour: activities are told apart by grey tone. The
 * printed sheet can add a hue, so a day reads at a glance on paper. The
 * palette is deliberately muted — 700s on paper, 400s on ink — and each
 * activity keeps the same hue whichever theme is chosen.
 */
const COLOURS = {
  light: {
    sleep: '#4F46E5',
    school: '#0E7490',
    coaching: '#C2410C',
    self_study: '#1D4ED8',
    physics: '#0F766E',
    chemistry: '#7C3AED',
    maths: '#B45309',
    biology: '#15803D',
    revision: '#9D174D',
    test: '#B91C1C',
    breaks: '#94A3B8',
    misc: '#475569',
  },
  dark: {
    sleep: '#818CF8',
    school: '#22D3EE',
    coaching: '#FB923C',
    self_study: '#60A5FA',
    physics: '#2DD4BF',
    chemistry: '#A78BFA',
    maths: '#FBBF24',
    biology: '#4ADE80',
    revision: '#FB7185',
    test: '#F87171',
    breaks: '#64748B',
    misc: '#CBD5E1',
  },
};

const FALLBACK = {
  light: ['#1D4ED8', '#0F766E', '#B45309', '#7C3AED', '#9D174D'],
  dark: ['#60A5FA', '#2DD4BF', '#FBBF24', '#A78BFA', '#FB7185'],
};

/** The tone attributes for one activity, with an inline hue in colour mode. */
function ink(key, theme, colour) {
  const tone = toneOf(key);
  if (colour === 'grey') return ` data-tone="${tone}"`;
  const dark = theme === 'dark';
  const hue = COLOURS[dark ? 'dark' : 'light'][key]
    || FALLBACK[dark ? 'dark' : 'light'][tone];
  return ` data-tone="${tone}" style="--tone:${hue}"`;
}

/* ── pieces ────────────────────────────────────────────────── */

/**
 * The day at a glance: one segment per block across a 24-hour bar.
 * Free time stays as the pale track underneath.
 */
function strip(blocks, theme, colour) {
  if (!blocks.length) return '';

  const segments = blocks.map((b) => {
    const left = (b.startMin / 1440) * 100;
    const width = ((b.endMin - b.startMin) / 1440) * 100;
    return `<span class="pdoc-seg"${ink(b.key, theme, colour)}`
      + ` style="left:${left.toFixed(3)}%;width:${width.toFixed(3)}%"></span>`;
  }).join('');

  const ticks = [0, 360, 720, 1080, 1440].map((minute) => {
    const at = (minute / 1440) * 100;
    const anchor = minute === 0 ? 'start' : (minute === 1440 ? 'end' : 'mid');
    return `<span class="pdoc-tick pdoc-tick--${anchor}" style="left:${at}%">`
      + `${esc(clockLabel(minute).replace(':00', ''))}</span>`;
  }).join('');

  return `
    <div class="pdoc-strip">
      <div class="pdoc-bar">${segments}</div>
      <div class="pdoc-ticks">${ticks}</div>
    </div>`;
}

function stats(sum, taskCount, taskDone) {
  const cell = (label, value) => `<div class="pdoc-stat">`
    + `<span class="pdoc-stat__label">${esc(label)}</span>`
    + `<span class="pdoc-stat__value">${esc(value)}</span></div>`;

  return `
    <div class="pdoc-stats">
      ${cell('Focus', dur(sum.studyMin))}
      ${cell('Planned', dur(sum.plannedMin))}
      ${cell('Free', dur(sum.freeMin))}
      ${cell('Tasks', taskCount ? `${taskDone}/${taskCount}` : '—')}
    </div>`;
}

function schedule(blocks, theme, colour, zen) {
  if (!blocks.length) {
    return '<p class="pdoc-empty">Nothing is planned for this day.</p>';
  }

  const rows = blocks.map(b => `
    <tr>
      <td class="pdoc-time">${esc(blockRangeLabel(b))}</td>
      <td class="pdoc-act"><span class="pdoc-swatch"${ink(b.key, theme, colour)}></span>${esc(b.label)}</td>
      <td class="pdoc-dur">${esc(dur(b.endMin - b.startMin))}</td>
    </tr>`).join('');

  const head = zen ? '' : `
      <thead>
        <tr>
          <th scope="col">Time</th>
          <th scope="col">Activity</th>
          <th scope="col" class="pdoc-dur">Length</th>
        </tr>
      </thead>`;

  return `
    <table class="pdoc-table">
      ${head}
      <tbody>${rows}</tbody>
    </table>`;
}

function taskSection(tasks) {
  if (!tasks.length) return '';

  // Grouped by stage, in the order the stages first appear.
  const groups = new Map();
  for (const t of tasks) {
    const stage = t.stage || 'General';
    if (!groups.has(stage)) groups.set(stage, []);
    groups.get(stage).push(t);
  }

  const done = tasks.filter(t => t.done).length;

  const groupHtml = [...groups].map(([stage, items]) => {
    const rows = items.map(t => `
      <li class="pdoc-task${t.done ? ' is-done' : ''}">
        <span class="pdoc-check">${t.done ? CHECK : ''}</span>
        <span class="pdoc-task__text">${esc(t.text)}</span>
      </li>`).join('');

    return `
      <section class="pdoc-taskgroup">
        <header class="pdoc-taskgroup__head">
          <span>${esc(stage)}</span>
          <span>${items.filter(t => t.done).length}/${items.length}</span>
        </header>
        <ul class="pdoc-tasklist">${rows}</ul>
      </section>`;
  }).join('');

  return `
    <section class="pdoc-section pdoc-tasks">
      <header class="pdoc-head">
        <h2>Tasks</h2>
        <span class="pdoc-head__note">${done} of ${tasks.length} done</span>
      </header>
      <div class="pdoc-taskgrid">${groupHtml}</div>
    </section>`;
}

function breakdown(blocks, freeMin, theme, colour) {
  if (!blocks.length) return '';

  const totals = new Map();
  for (const b of blocks) {
    const entry = totals.get(b.key) || { key: b.key, label: b.label, min: 0 };
    entry.min += b.endMin - b.startMin;
    totals.set(b.key, entry);
  }

  const rows = [...totals.values()].sort((a, b) => b.min - a.min);
  if (freeMin > 0) rows.push({ key: '', label: 'Free', min: freeMin, free: true });

  const items = rows.map((row) => {
    const share = pct(row.min);
    return `
      <div class="pdoc-mix${row.free ? ' is-free' : ''}">
        <span class="pdoc-mix__label">${esc(row.label)}</span>
        <span class="pdoc-mix__min">${esc(dur(row.min))}</span>
        <span class="pdoc-mix__pct">${share}%</span>
        <span class="pdoc-mix__track"><span class="pdoc-mix__fill"${row.free ? '' : ink(row.key, theme, colour)} style="width:${share}%"></span></span>
      </div>`;
  }).join('');

  return `
    <section class="pdoc-section pdoc-breakdown">
      <header class="pdoc-head">
        <h2>Breakdown</h2>
        <span class="pdoc-head__note">share of the day</span>
      </header>
      <div class="pdoc-mixgrid">${items}</div>
    </section>`;
}

/* ── the document ──────────────────────────────────────────── */

/**
 * Build the print view of one day.
 *
 * @param {object} options
 * @param {object} options.plan    the plan to print
 * @param {string} options.date    its date key
 * @param {string} [options.theme] 'light' | 'dark'
 * @param {string} [options.colour] 'colour' | 'grey'
 * @param {boolean} [options.zen]  a calmer sheet: no stats, tasks or breakdown
 * @returns {string} HTML for the print container
 */
export function buildPlanPrint({
  plan, date, theme = 'light', colour = 'colour', zen = false,
}) {
  const blocks = (plan?.blocks || []).slice()
    .sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  const tasks = plan?.tasks || [];
  const sum = planSummary(plan || { blocks: [], tasks: [] });
  const day = labelDate(date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  const head = `
    <header class="pdoc-top">
      <span class="pdoc-brand">Cadence</span>
      <span class="pdoc-day">${esc(day)}</span>
    </header>

    <h1 class="pdoc-title">Day plan</h1>`;

  if (zen) {
    return `
      ${head}
      ${strip(blocks, theme, colour)}

      <section class="pdoc-section pdoc-schedule pdoc-schedule--zen">
        ${schedule(blocks, theme, colour, true)}
      </section>`;
  }

  return `
    ${head}

    ${stats(sum, tasks.length, tasks.filter(t => t.done).length)}
    ${strip(blocks, theme, colour)}

    <section class="pdoc-section pdoc-schedule">
      <header class="pdoc-head">
        <h2>Schedule</h2>
        <span class="pdoc-head__note">${blocks.length} ${blocks.length === 1 ? 'block' : 'blocks'}</span>
      </header>
      ${schedule(blocks, theme, colour, false)}
    </section>

    ${taskSection(tasks)}
    ${breakdown(blocks, sum.freeMin, theme, colour)}

    <footer class="pdoc-foot">
      <span>Cadence — plan the day, run the day</span>
      <span>${esc(day)}</span>
    </footer>`;
}
