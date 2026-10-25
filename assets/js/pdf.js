/**
 * Cadence — a very small PDF text extractor.
 *
 * It exists for one reason: importing a TestOnGo "Dashboard" export without
 * shipping a 400 kB parser. The file is read entirely in the browser and
 * never leaves the device.
 *
 * What it does:
 *   • finds every `N 0 obj` in the raw bytes (no xref table needed)
 *   • inflates FlateDecode streams with the platform `DecompressionStream`
 *   • interprets the page content stream (text matrices, CTM, glyph runs)
 *   • decodes glyphs through each font's ToUnicode CMap
 *   • regroups the glyphs into visual lines and column "cells"
 *
 * What it deliberately does not do: rasterise, handle encrypted files, or
 * support LZW/DJB/JBIG2 filters. Anything it cannot read, it skips.
 */

// Lookbehind-free on purpose: `(?<!...)` throws a SyntaxError at compile time
// on older Safari and takes the whole module graph down. The leading character
// is consumed into the match instead; group 1 accounts for it.
const OBJ_RE = /(^|[^0-9])(\d+)\s+(\d+)\s+obj\b/g;
const STREAM_RE = /stream\r\n|stream\r|stream\n/;

const TOKEN_RE = new RegExp(
  [
    '\\/([^\\s/\\[\\]<>(){}]+)',            // 1  name
    '|<([0-9A-Fa-f\\s]*)>',                 // 2  hex string
    '|(\\((?:[^()\\\\]|\\\\[\\s\\S])*\\))',  // 3  literal string
    '|([+-]?(?:\\d+\\.?\\d*|\\.\\d+))',      // 4  number
    '|(<<|>>|\\[|\\])',                     // 5  dict / array marker
    '|([A-Za-z\'"][A-Za-z0-9\'"]*)',        // 6  operator
  ].join(''),
  'g'
);

const IDENTITY = [1, 0, 0, 1, 0, 0];

/* ── byte / string helpers ─────────────────────────────────── */

/** Byte-per-char string so that string offsets equal byte offsets. */
function toLatin1(bytes) {
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return out;
}

function matMul(m, n) {
  const a1 = m[0], b1 = m[1], c1 = m[2], d1 = m[3], e1 = m[4], f1 = m[5];
  const a2 = n[0], b2 = n[1], c2 = n[2], d2 = n[3], e2 = n[4], f2 = n[5];
  return [
    a1 * a2 + b1 * c2,
    a1 * b2 + b1 * d2,
    c1 * a2 + d1 * c2,
    c1 * b2 + d1 * d2,
    e1 * a2 + f1 * c2 + e2,
    e1 * b2 + f1 * d2 + f2,
  ];
}

function matApply(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/* ── stream inflation ───────────────────────────────────────── */

async function inflate(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot decompress PDF streams (DecompressionStream missing).');
  }
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* ── object index ──────────────────────────────────────────── */

function indexObjects(raw) {
  const map = new Map();
  OBJ_RE.lastIndex = 0;
  let m;
  while ((m = OBJ_RE.exec(raw)) !== null) {
    const num = Number(m[2]);
    const start = m.index + m[0].length;
    const endIdx = raw.indexOf('endobj', start);
    map.set(num, { start, end: endIdx === -1 ? raw.length : endIdx });
  }
  return map;
}

function objectBody(raw, obj) {
  return raw.slice(obj.start, obj.end);
}

/** Raw (still compressed) bytes of an object's stream, or null. */
function rawStreamBytes(raw, bytes, obj) {
  const body = objectBody(raw, obj);
  const sm = STREAM_RE.exec(body);
  if (!sm) return null;
  const dataStart = obj.start + sm.index + sm[0].length;
  const es = raw.indexOf('endstream', dataStart);
  if (es === -1) return null;
  let end = es;
  if (raw[end - 1] === '\n') end -= 1;
  if (raw[end - 1] === '\r') end -= 1;
  return { data: bytes.subarray(dataStart, end), dict: body.slice(0, sm.index) };
}

async function objectStream(raw, bytes, obj) {
  const rs = rawStreamBytes(raw, bytes, obj);
  if (!rs) return null;
  if (!/\/FlateDecode/.test(rs.dict)) {
    // Uncompressed or an unsupported filter — try as plain text.
    return toLatin1(rs.data);
  }
  try {
    return toLatin1(await inflate(rs.data));
  } catch {
    return null;
  }
}

/* ── ToUnicode CMaps ───────────────────────────────────────── */

function parseCMap(src) {
  const map = new Map();
  const charBlock = /beginbfchar([\s\S]*?)endbfchar/g;
  let m;
  while ((m = charBlock.exec(src)) !== null) {
    const pairs = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let p;
    while ((p = pairs.exec(m[1])) !== null) {
      map.set(parseInt(p[1], 16), hexToText(p[2]));
    }
  }
  const rangeBlock = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = rangeBlock.exec(src)) !== null) {
    const triples = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let t;
    while ((t = triples.exec(m[1])) !== null) {
      const lo = parseInt(t[1], 16);
      const hi = parseInt(t[2], 16);
      const dst = parseInt(t[3], 16);
      for (let i = lo; i <= hi && i - lo < 65535; i += 1) {
        map.set(i, String.fromCodePoint(dst + (i - lo)));
      }
    }
  }
  return map;
}

function hexToText(hex) {
  let out = '';
  for (let i = 0; i + 3 < hex.length + 1; i += 4) {
    const code = parseInt(hex.slice(i, i + 4), 16);
    if (Number.isNaN(code)) break;
    out += String.fromCharCode(code);
  }
  return out;
}

/* ── literal string escapes ────────────────────────────────── */

function literalToText(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i];
    if (c !== '\\') { out += c; continue; }
    const n = raw[++i];
    if (n === undefined) break;
    if (n === 'n') out += '\n';
    else if (n === 'r') out += '\r';
    else if (n === 't') out += '\t';
    else if (n === 'b') out += '\b';
    else if (n === 'f') out += '\f';
    else if (n >= '0' && n <= '7') {
      let oct = n;
      while (oct.length < 3 && raw[i + 1] >= '0' && raw[i + 1] <= '7') {
        oct += raw[++i];
      }
      out += String.fromCharCode(parseInt(oct, 8) & 0xff);
    } else out += n;
  }
  return out;
}

/* ── page discovery ────────────────────────────────────────── */

function findPages(raw, objects) {
  const pages = [];
  for (const [num, obj] of objects) {
    const body = objectBody(raw, obj);
    if (!/\/Type\s*\/Page\b/.test(body)) continue;
    if (/\/Type\s*\/Pages\b/.test(body)) continue;
    const contents = [];
    const cre = /\/Contents\s+(\d+)\s+\d+\s+R/g;
    let cm;
    while ((cm = cre.exec(body)) !== null) contents.push(Number(cm[1]));
    if (/\/Contents\s*\[/.test(body)) {
      const arr = /\/Contents\s*\[([^\]]*)\]/.exec(body);
      if (arr) {
        const re = /(\d+)\s+\d+\s+R/g;
        let am;
        while ((am = re.exec(arr[1])) !== null) contents.push(Number(am[1]));
      }
    }
    let fonts = {};
    const res = /\/Resources\s+(\d+)\s+\d+\s+R/.exec(body);
    const resBody = res ? objectBody(raw, objects.get(Number(res[1])) || { start: 0, end: 0 }) : body;
    const fm = /\/Font\s*<<([\s\S]*?)>>/.exec(resBody) || /\/Font\s*<<([\s\S]*?)>>/.exec(body);
    if (fm) {
      const re = /\/([A-Za-z0-9#._-]+)\s+(\d+)\s+\d+\s+R/g;
      let am;
      while ((am = re.exec(fm[1])) !== null) fonts[am[1]] = Number(am[2]);
    }
    pages.push({ num, contents, fonts });
  }
  return pages;
}

/* ── content stream interpretation ─────────────────────────── */

function decodeShowText(token, cmap) {
  if (token.startsWith('<')) {
    const hex = token.slice(1, -1).replace(/\s+/g, '');
    let out = '';
    for (let i = 0; i + 3 < hex.length + 1; i += 4) {
      const code = parseInt(hex.slice(i, i + 4), 16);
      if (Number.isNaN(code)) break;
      out += cmap.get(code) ?? '';
    }
    return out;
  }
  const inner = token.slice(1, -1);
  let out = '';
  for (const ch of literalToText(inner)) out += cmap.get(ch.charCodeAt(0)) ?? '';
  return out;
}

/**
 * Runs one page's content streams and returns positioned glyph runs.
 * `runs` entries look like { x, y, text, size } in device space, where y
 * grows upwards (standard PDF orientation).
 */
function runContentStream(src, fonts, cmaps) {
  const runs = [];
  let ctm = IDENTITY.slice();
  const stack = [];
  let tm = IDENTITY.slice();
  let tlm = IDENTITY.slice();
  let size = 12;
  let cmap = new Map();

  const args = [];
  let lastName = null;

  const emit = (text) => {
    if (!text) return;
    const p = matApply(matMul(tm, ctm), 0, 0);
    runs.push({ x: p[0], y: p[1], text, size });
  };

  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(src)) !== null) {
    if (m[1] !== undefined) { lastName = m[1]; args.push({ name: m[1] }); continue; }
    if (m[2] !== undefined) { args.push({ str: '<' + m[2] + '>' }); continue; }
    if (m[3] !== undefined) { args.push({ str: m[3] }); continue; }
    if (m[4] !== undefined) { args.push({ num: Number(m[4]) }); continue; }
    if (m[5] !== undefined) { continue; }

    const op = m[6];
    const nums = args.filter(a => a.num !== undefined).map(a => a.num);

    switch (op) {
      case 'q': stack.push(ctm.slice()); break;
      case 'Q': ctm = stack.length ? stack.pop() : ctm; break;
      case 'cm':
        if (nums.length >= 6) ctm = matMul(nums.slice(-6), ctm);
        break;
      case 'BT': tm = IDENTITY.slice(); tlm = IDENTITY.slice(); break;
      case 'ET': break;
      case 'Tf': {
        size = nums.length ? nums[nums.length - 1] : size;
        const obj = fonts[lastName];
        cmap = cmaps.get(obj) || new Map();
        break;
      }
      case 'Tm':
        if (nums.length >= 6) { tm = nums.slice(-6); tlm = tm.slice(); }
        break;
      case 'Td':
      case 'TD':
        if (nums.length >= 2) {
          tlm = matMul([1, 0, 0, 1, nums[nums.length - 2], nums[nums.length - 1]], tlm);
          tm = tlm.slice();
        }
        break;
      case 'T*':
        tlm = matMul([1, 0, 0, 1, 0, -size * 1.2], tlm);
        tm = tlm.slice();
        break;
      case 'Tj': {
        const last = args[args.length - 1];
        if (last && last.str) emit(decodeShowText(last.str, cmap));
        break;
      }
      case 'TJ': {
        const last = args[args.length - 1];
        if (last && last.str) {
          emit(decodeShowText(last.str, cmap));
          // Approximate the advance so that later runs keep their spacing.
          const chars = last.str.startsWith('<')
            ? Math.floor((last.str.length - 2) / 4)
            : last.str.length - 2;
          tm = matMul([1, 0, 0, 1, size * 0.5 * chars, 0], tm);
        }
        break;
      }
      default: break;
    }
    args.length = 0;
    if (op !== 'Tf') lastName = lastName;
  }
  return runs;
}

/* ── layout reconstruction ─────────────────────────────────── */

/**
 * Groups glyph runs into visual lines, then into column cells.
 *
 * A cell break happens when the horizontal gap between two glyphs is far
 * larger than the glyph advance would explain — which is exactly how a
 * table column boundary looks. Spaces are real glyphs in these PDFs, so
 * word breaks are preserved for free.
 */
function buildLines(runs) {
  const sorted = runs.slice().sort((a, b) => (b.y - a.y) || (a.x - b.x));
  const lines = [];
  for (const run of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - run.y) < 3) {
      last.runs.push(run);
    } else {
      lines.push({ y: run.y, runs: [run] });
    }
  }

  return lines.map((line) => {
    line.runs.sort((a, b) => a.x - b.x);
    const cells = [];
    let cur = null;
    let prev = null;
    for (const run of line.runs) {
      if (prev) {
        const gap = run.x - prev.x;
        const limit = Math.max(12, prev.size * 1.8);
        if (gap > limit) {
          cur = null;
        }
      }
      if (!cur) {
        cur = { x: run.x, text: '', size: run.size };
        cells.push(cur);
      }
      cur.text += run.text;
      prev = run;
    }
    return { y: line.y, cells: cells.filter(c => c.text.trim().length > 0) };
  }).filter(l => l.cells.length > 0);
}

/* ── public API ────────────────────────────────────────────── */

/**
 * @param {ArrayBuffer} buffer  raw PDF bytes
 * @returns {Promise<Array<{lines: Array<{y:number, cells:Array<{x:number,text:string,size:number}>}>}>>}
 */
export async function extractPdfLayout(buffer) {
  const bytes = new Uint8Array(buffer);
  const raw = toLatin1(bytes);
  const objects = indexObjects(raw);

  // ToUnicode CMaps, keyed by font object number.
  const cmaps = new Map();
  for (const [num, obj] of objects) {
    const body = objectBody(raw, obj);
    if (!/\/Subtype\s*\/Type0/.test(body)) continue;
    const tu = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(body);
    if (!tu) continue;
    const tuObj = objects.get(Number(tu[1]));
    if (!tuObj) continue;
    const src = await objectStream(raw, bytes, tuObj);
    if (!src) continue;
    cmaps.set(num, parseCMap(src));
  }

  const pages = findPages(raw, objects);
  const out = [];
  for (const page of pages) {
    const runs = [];
    for (const cn of page.contents) {
      const obj = objects.get(cn);
      if (!obj) continue;
      const src = await objectStream(raw, bytes, obj);
      if (!src) continue;
      runs.push(...runContentStream(src, page.fonts, cmaps));
    }
    out.push({ lines: buildLines(runs) });
  }
  return out;
}
