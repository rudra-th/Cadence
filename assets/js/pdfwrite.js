/**
 * Cadence — a very small PDF writer.
 *
 * The plan page can hand the day back as a PDF. There is no library here on
 * purpose: the file is a couple of kilobytes of PDF written by hand, it
 * opens in every reader, and it works with the network off.
 *
 * What it writes: a title, the schedule as a two-column table, and the
 * tasks. Standard Type 1 fonts (Helvetica) are used, so nothing has to be
 * embedded and the file stays tiny.
 */

const PAGE = {
  w: 595.28,          // A4, in points
  h: 841.89,
  margin: 54,
  bottom: 58,
};

const INK = '0.09 0.10 0.12';
const INK_DIM = '0.42 0.45 0.50';
const INK_FAINT = '0.62 0.65 0.70';
const RULE = '0.86 0.87 0.89';
const ACCENT = '0.31 0.48 0.85';

/* ── text helpers ───────────────────────────────────────────── */

const TYPO = {
  '‘': "'", '’': "'", '“': '"', '”': '"',
  '–': '-', '—': '-', '·': '-', '…': '...',
  ' ': ' ',
};

/** Make a string safe for a PDF literal string. */
function escapeText(text) {
  return String(text == null ? '' : text)
    .replace(/[‘’“”–—·… ]/g, ch => TYPO[ch] ?? ch)
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '?')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

/** A rough width of a Helvetica string — good enough to right-align it. */
function textWidth(text, size, bold) {
  const s = String(text || '');
  return s.length * size * (bold ? 0.56 : 0.51);
}

/* ── layout ─────────────────────────────────────────────────── */

/**
 * Turn a plan into a list of rows.
 *
 * Every row knows how tall it is; the paginator uses that to decide where
 * a page ends.
 */
function layout(doc) {
  const rows = [];
  let y = 0;

  const add = (row) => {
    rows.push({ ...row, y });
    y += row.h;
  };

  add({ kind: 'title', text: doc.title || 'Cadence plan', size: 19, bold: true, h: 25 });
  if (doc.subtitle) add({ kind: 'text', text: doc.subtitle, size: 10, color: INK_DIM, h: 15 });
  add({ kind: 'gap', h: 6 });
  add({ kind: 'rule', color: ACCENT, weight: 1.4, h: 14 });

  const blocks = doc.blocks || [];
  if (blocks.length) {
    add({ kind: 'head', text: 'SCHEDULE', size: 9.5, bold: true, color: INK_FAINT, h: 18 });
    for (const b of blocks) {
      add({
        kind: 'row',
        left: b.range || '',
        mid: b.label || '',
        right: b.duration || '',
        h: 17,
      });
    }
  } else {
    add({ kind: 'text', text: 'Nothing is planned for this day.', size: 10.5, color: INK_DIM, h: 18 });
  }

  const tasks = doc.tasks || [];
  if (tasks.length) {
    add({ kind: 'gap', h: 12 });
    add({ kind: 'head', text: 'TASKS', size: 9.5, bold: true, color: INK_FAINT, h: 18 });
    for (const t of tasks) {
      add({
        kind: 'row',
        left: t.done ? '[x]' : '[  ]',
        mid: t.text || '',
        right: '',
        h: 16,
      });
    }
  }

  if (doc.footer) {
    add({ kind: 'gap', h: 14 });
    add({ kind: 'text', text: doc.footer, size: 9, color: INK_FAINT, h: 14 });
  }

  return rows;
}

/** Split the rows into pages. */
function paginate(rows) {
  const limit = PAGE.h - PAGE.bottom;
  const pages = [];
  let page = [];
  let used = 0;

  for (const row of rows) {
    if (used + row.h > limit && page.length) {
      pages.push(page);
      page = [];
      used = 0;
    }
    page.push(row);
    used += row.h;
  }
  if (page.length) pages.push(page);
  if (!pages.length) pages.push([]);
  return pages;
}

/* ── content streams ────────────────────────────────────────── */

/** The text operators for one page. */
function pageContent(rows) {
  const out = [];
  for (const row of rows) {
    const y = (PAGE.h - PAGE.margin) - row.y;

    if (row.kind === 'gap') continue;

    if (row.kind === 'rule') {
      out.push(`${RULE} RG ${row.weight || 1} w ${PAGE.margin} ${y.toFixed(2)} m `
        + `${(PAGE.w - PAGE.margin).toFixed(2)} ${y.toFixed(2)} l S`);
      continue;
    }

    if (row.kind === 'row') {
      if (row.left) {
        out.push(textOp(row.left, PAGE.margin, y, 9.5, false, INK_DIM, 'F1'));
      }
      if (row.mid) {
        out.push(textOp(row.mid, PAGE.margin + 96, y, 10.5, false, INK, 'F1'));
      }
      if (row.right) {
        const w = textWidth(row.right, 9.5, false);
        out.push(textOp(row.right, PAGE.w - PAGE.margin - w, y, 9.5, false, INK_DIM, 'F1'));
      }
      continue;
    }

    const size = row.size || 10.5;
    const font = row.bold ? 'F2' : 'F1';
    const color = row.color || INK;
    out.push(textOp(row.text, PAGE.margin, y, size, !!row.bold, color, font));
  }
  return out.join('\n');
}

function textOp(text, x, y, size, bold, color, font) {
  return `BT ${color} rg /${font} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm `
    + `(${escapeText(text)}) Tj ET`;
}

/* ── the file ───────────────────────────────────────────────── */

function assemble(pages) {
  const objects = [];

  // 1 catalog, 2 pages, 3 regular font, 4 bold font — reserved up front.
  objects.push('', '', '', '');

  const pageIds = [];
  for (const rows of pages) {
    const content = pageContent(rows);
    const contentId = objects.length + 1;
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    const pageId = objects.length + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.w.toFixed(2)} ${PAGE.h.toFixed(2)}] `
      + `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`
    );
    pageIds.push(pageId);
  }

  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[2] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';

  let out = '%PDF-1.4\n';
  out += '%\xE2\xE3\xCF\xD3\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n`;
  out += '0000000000 65535 f \n';
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  // Every character is below 256, so the string length is the byte length.
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i += 1) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}

/**
 * Build a PDF of a day.
 *
 * @param {object} doc
 * @param {string} doc.title
 * @param {string} [doc.subtitle]
 * @param {Array}  [doc.blocks]  {range, label, duration}
 * @param {Array}  [doc.tasks]   {text, done}
 * @param {string} [doc.footer]
 * @returns {Uint8Array}
 */
export function buildPlanPdf(doc) {
  return assemble(paginate(layout(doc || {})));
}

/**
 * The plan as a PDF, ready to be handed to the browser as a download.
 */
export function downloadPlanPdf(doc, filename) {
  const bytes = buildPlanPdf(doc);
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'cadence-plan.pdf';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return bytes.length;
}
