/**
 * Cadence — TestOnGo "Dashboard" timetable parsing.
 *
 * TestOnGo exports a one-page dashboard PDF whose schedule table looks like:
 *
 *      SCHEDULE
 *
 *        12:00 AM - 1:00 AM      Misc                 1h
 *        1:00 AM - 9:30 AM       Sleep                8h
 *                                                              30m
 *        9:30 AM - 10:00 AM      Misc                 30m
 *        10:00 AM - 12:30 PM     Self study           2h
 *                                                              30m
 *        ...
 *
 * Two details matter:
 *   • the duration cell can wrap onto a second line ("2h" then "30m")
 *   • the schedule crosses midnight, so a range may end on the next day
 *
 * The parser works on the *visual* layout produced by `pdf.js` — lines of
 * column cells — so it stays readable and does not care how the PDF was
 * generated.
 */

const RANGE_RE = /(\d{1,2}):(\d{2})\s*([AP])\s*M\s*[-–—]+\s*(\d{1,2}):(\d{2})\s*([AP])\s*M/i;
const RANGE_24_RE = /(?<![\d:])(\d{1,2}):(\d{2})\s*[-–—]+\s*(\d{1,2}):(\d{2})(?![\d:])/;
const DATE_RE = /^([A-Za-z]+day),?\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/i;
const BREAK_RE = /\b(break|sleep|rest|lunch|meal|recess|nap|tea)\b/i;

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];

/* ── small parsers ─────────────────────────────────────────── */

/** "9:30 PM" → 1290 minutes past midnight. */
export function parseClock(hh, mm, meridiem) {
  let h = Number(hh);
  const m = Number(mm);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  const pm = String(meridiem).toUpperCase() === 'P';
  if (h === 12) h = 0;
  if (pm) h += 12;
  return h * 60 + m;
}

/** "2h 30m" / "45m" / "1h" → milliseconds. */
export function parseDuration(text) {
  if (!text) return null;
  const t = text.trim();
  const hMatch = /(\d+(?:\.\d+)?)\s*(?:h|hr|hour|hours)/i.exec(t);
  const mMatch = /(\d+)\s*(?:m|min|mins|minutes)/i.exec(t);
  let minutes = 0;
  if (hMatch) minutes += Number(hMatch[1]) * 60;
  if (mMatch) minutes += Number(mMatch[1]);
  if (!hMatch && !mMatch) {
    const bare = /^\s*(\d+)\s*$/.exec(t);
    if (!bare) return null;
    minutes = Number(bare[1]);
  }
  if (!minutes) return null;
  return minutes * 60000;
}

/* ── schedule extraction ───────────────────────────────────── */

function findScheduleStart(lines) {
  for (let i = 0; i < lines.length; i += 1) {
    const joined = lines[i].cells.map(c => c.text).join(' ').trim();
    if (/^SCHEDULE$/i.test(joined.replace(/\s+/g, ''))) return i;
  }
  return -1;
}

function findDate(lines) {
  for (const line of lines) {
    for (const cell of line.cells) {
      const m = DATE_RE.exec(cell.text.trim());
      if (!m) continue;
      const month = MONTHS.indexOf(m[3].toLowerCase());
      if (month < 0) continue;
      const d = new Date(Number(m[4]), month, Number(m[2]));
      if (Number.isNaN(d.getTime())) continue;
      return d;
    }
  }
  return null;
}

function findSubjects(lines) {
  const out = [];
  const start = lines.findIndex(l => /^TASKS$/i.test(l.cells.map(c => c.text).join('').replace(/\s+/g, '')));
  if (start < 0) return out;
  for (let i = start + 1; i < lines.length; i += 1) {
    const joined = lines[i].cells.map(c => c.text).join(' ').trim();
    if (/^BREAKDOWN$/i.test(joined.replace(/\s+/g, ''))) break;
    // A row can hold several subject groups side by side ("Physics 0/1  Chemistry 0/2").
    const re = /([A-Za-z][A-Za-z .&'-]*?)\s+(\d+)\s*\/\s*(\d+)/g;
    let m;
    while ((m = re.exec(joined)) !== null) {
      const name = m[1].trim();
      if (!name) continue;
      out.push({ name, done: Number(m[2]), total: Number(m[3]) });
    }
  }
  return out;
}

/**
 * Parse a TestOnGo dashboard.
 * @param {Array} pages  output of `extractPdfLayout`
 * @returns {object|null}  timetable description
 */
export function parseTestOnGo(pages) {
  const lines = [];
  for (const page of pages) lines.push(...page.lines);

  const scheduleAt = findScheduleStart(lines);
  if (scheduleAt < 0) return null;

  const date = findDate(lines);
  const dayStart = date
    ? new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
    : new Date().setHours(0, 0, 0, 0);

  const sessions = [];
  for (let i = scheduleAt + 1; i < lines.length; i += 1) {
    const line = lines[i];
    const cells = line.cells;
    if (!cells.length) continue;

    const first = cells[0].text.trim();
    const m = RANGE_RE.exec(first);
    if (!m) {
      // Not a schedule row — stop at the first thing that is not a row.
      if (sessions.length) break;
      continue;
    }

    const startMin = parseClock(m[1], m[2], m[3]);
    let endMin = parseClock(m[4], m[5], m[6]);
    if (startMin === null || endMin === null) continue;
    if (endMin <= startMin) endMin += 1440;            // crosses midnight

    const subject = (cells[1] ? cells[1].text : '').trim() || 'Session';

    // The duration cell may wrap onto the next line ("2h" / "30m").
    let durationText = cells[2] ? cells[2].text.trim() : '';
    const next = lines[i + 1];
    if (next && next.cells.length === 1) {
      const cont = next.cells[0];
      const nearDuration = !cells[2] || Math.abs(cont.x - cells[2].x) < 60;
      if (nearDuration && /^\d+\s*(?:m|min|mins|minutes)\s*$/i.test(cont.text.trim())) {
        durationText = `${durationText} ${cont.text.trim()}`.trim();
        i += 1;                                          // consume the wrapped line
      }
    }

    let durationMs = parseDuration(durationText);
    if (!durationMs) durationMs = (endMin - startMin) * 60000;

    sessions.push({
      id: `tt-${startMin}-${endMin}-${sessions.length}`,
      subject,
      startMin,
      endMin,
      start: dayStart + startMin * 60000,
      end: dayStart + endMin * 60000,
      durationMs,
      isBreak: BREAK_RE.test(subject),
    });
  }

  if (!sessions.length) return null;

  sessions.sort((a, b) => a.start - b.start);

  return {
    date: isoDate(dayStart),
    dayLabel: date
      ? date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
      : 'Imported timetable',
    dayStart,
    sessions,
    subjects: findSubjects(lines),
    importedAt: Date.now(),
    done: {},
  };
}

/* ── helpers ───────────────────────────────────────────────── */

export function isoDate(ts) {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * Read any timetable PDF.
 *
 * A TestOnGo dashboard is read the way it is written — the SCHEDULE table,
 * with its wrapped duration cells. Anything else is read the plain way: any
 * row that holds a time range becomes a session, and the text next to it
 * becomes its name.
 *
 * @param {Array} pages  output of `extractPdfLayout`
 * @returns {object|null}  timetable description
 */
export function parseSchedule(pages) {
  const known = parseTestOnGo(pages);
  if (known) return known;
  return parseGenericSchedule(pages);
}

/**
 * The plain reader — a row is a session when it starts with a time range.
 */
export function parseGenericSchedule(pages) {
  const lines = [];
  for (const page of pages) lines.push(...page.lines);

  const sessions = [];
  const seen = new Set();

  for (const line of lines) {
    const cells = line.cells;
    if (!cells.length) continue;
    const first = cells[0].text.trim();

    let startMin = null;
    let endMin = null;

    const ampm = RANGE_RE.exec(first);
    if (ampm) {
      startMin = parseClock(ampm[1], ampm[2], ampm[3]);
      endMin = parseClock(ampm[4], ampm[5], ampm[6]);
    } else {
      const plain = RANGE_24_RE.exec(first);
      if (plain) {
        const h1 = Number(plain[1]);
        const m1 = Number(plain[2]);
        const h2 = Number(plain[3]);
        const m2 = Number(plain[4]);
        if (h1 < 24 && h2 < 24 && m1 < 60 && m2 < 60) {
          startMin = h1 * 60 + m1;
          endMin = h2 * 60 + m2;
        }
      }
    }

    if (startMin === null || endMin === null) continue;
    if (endMin <= startMin) endMin += 1440;              // crosses midnight
    if (endMin - startMin > 1440) continue;

    const subject = cells.slice(1)
      .map(c => c.text.trim())
      .filter(Boolean)
      .join(' ')
      .trim() || 'Session';

    const key = `${startMin}-${endMin}-${subject.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    sessions.push({
      id: `gt-${startMin}-${endMin}-${sessions.length}`,
      subject: subject.slice(0, 60),
      startMin,
      endMin,
      durationMs: (endMin - startMin) * 60000,
      isBreak: BREAK_RE.test(subject),
    });
  }

  if (!sessions.length) return null;
  sessions.sort((a, b) => a.startMin - b.startMin);

  const date = findDate(lines);
  const dayStart = date
    ? new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
    : new Date().setHours(0, 0, 0, 0);

  return {
    date: isoDate(dayStart),
    dayLabel: date
      ? date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
      : 'Imported timetable',
    dayStart,
    sessions,
    subjects: findSubjects(lines),
    importedAt: Date.now(),
    done: {},
  };
}

/** The session covering `now`, or the next one that has not started. */
export function activeSession(timetable, now = Date.now()) {
  if (!timetable || !timetable.sessions) return null;
  for (const s of timetable.sessions) {
    if (now >= s.start && now < s.end) return s;
  }
  return null;
}

export function nextSession(timetable, now = Date.now()) {
  if (!timetable || !timetable.sessions) return null;
  for (const s of timetable.sessions) {
    if (s.start > now) return s;
  }
  return null;
}

/** 'done' | 'active' | 'upcoming' */
export function sessionPhase(session, now = Date.now()) {
  if (now >= session.end) return 'done';
  if (now >= session.start) return 'active';
  return 'upcoming';
}

export function timetableTotalMs(timetable) {
  if (!timetable) return 0;
  return timetable.sessions.reduce((sum, s) => sum + (s.isBreak ? 0 : s.durationMs), 0);
}
