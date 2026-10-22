/**
 * Cadence — importing a timetable.
 *
 * One place reads a timetable PDF and writes it into the store, so the plan
 * page and the clock page behave the same way whichever one did the import.
 *
 * The file is read entirely on the device — nothing is uploaded anywhere.
 */

import { extractPdfLayout } from './pdf.js';
import { parseSchedule } from './timetable.js';
import { blocksFromSessions, customActivitiesFor, emptyPlan } from './plan.js';
import { setPlan } from './store.js';
import { dateKey } from './util.js';

/**
 * Read a timetable PDF and turn it into a plan.
 *
 * @param {object} state  the store
 * @param {File}   file   the PDF the person picked or dropped
 * @returns {Promise<{date:string, blocks:number, label:string, sessions:Array}>}
 * @throws  {Error} when the file holds no schedule that can be read
 */
export async function importTimetable(state, file) {
  if (!file) throw new Error('no-file');

  const buffer = await file.arrayBuffer();
  const pages = await extractPdfLayout(buffer);
  const tt = parseSchedule(pages);
  if (!tt) throw new Error('no-schedule-found');

  const date = tt.date || dateKey(Date.now());
  const blocks = blocksFromSessions(tt.sessions, state.activities);

  // Subjects the app does not know yet become activities of their own, so
  // they can be picked with the brush like any other.
  const extra = customActivitiesFor(blocks, state.activities);
  if (extra.length) state.activities = [...state.activities, ...extra];

  const previous = state.plans[date] || emptyPlan(date);
  setPlan(state, date, {
    ...previous,
    date,
    blocks,
    tasks: previous.tasks || [],
    imported: {
      label: tt.dayLabel || '',
      subjects: tt.subjects || [],
    },
    done: {},
  });

  return {
    date,
    blocks: blocks.length,
    label: tt.dayLabel || '',
    sessions: tt.sessions || [],
  };
}

/**
 * The message that goes with a failed import.
 *
 * The wording says what was wrong without blaming the person for it.
 */
export function importErrorMessage(err) {
  if (err && err.message === 'no-schedule-found') {
    return 'No timetable could be read from that file — a schedule with times and names is needed.';
  }
  if (err && err.message === 'no-file') return 'No file was chosen.';
  return 'That file could not be read. Try exporting the timetable as a PDF again.';
}
