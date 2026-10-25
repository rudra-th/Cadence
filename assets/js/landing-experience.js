/**
 * CADENCE — "A day in four acts"
 * ------------------------------------------------------------------
 * One rAF loop. Lenis smooths the wheel, a single pinned section is
 * scrubbed by scroll position, and a canvas draws the whole film so
 * the page reads like a video instead of a stack of sections.
 *
 * No frameworks, no network, no dependencies beyond the vendored Lenis.
 */

(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const smooth = (a, b, x) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer = window.matchMedia('(pointer: fine)').matches;

  /* ──────────────────────────────────────────────────────────────
     Boot leader
     ────────────────────────────────────────────────────────────── */

  function boot() {
    const el = $('#boot');
    if (!el) return;

    const pct = $('#bootPct');
    const bar = $('#bootBar');

    const ready = () => {
      document.body.classList.add('is-ready');
    };

    if (reduceMotion) {
      el.remove();
      ready();
      return;
    }

    let started = 0;
    const duration = 720;

    const step = (now) => {
      if (!started) started = now;
      const raw = clamp((now - started) / duration, 0, 1);
      const eased = 1 - Math.pow(1 - raw, 3);

      if (pct) pct.textContent = String(Math.round(eased * 100)).padStart(3, '0');
      if (bar) bar.style.transform = `scaleX(${eased})`;

      if (raw < 1) {
        requestAnimationFrame(step);
      } else {
        el.classList.add('is-done');
        ready();
        window.setTimeout(() => el.remove(), 1000);
      }
    };

    requestAnimationFrame(step);
  }

  /* ──────────────────────────────────────────────────────────────
     Smooth scrolling
     ────────────────────────────────────────────────────────────── */

  let lenis = null;

  function initScroll() {
    if (reduceMotion || typeof window.Lenis === 'undefined') return;

    lenis = new window.Lenis({
      duration: 1.15,
      easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      smoothWheel: true,
      wheelMultiplier: 1,
      touchMultiplier: 1.5,
    });

    const raf = (time) => {
      lenis.raf(time);
      requestAnimationFrame(raf);
    };
    requestAnimationFrame(raf);

    $$('a[href^="#"]').forEach((link) => {
      link.addEventListener('click', (event) => {
        const id = link.getAttribute('href');
        if (!id || id.length < 2) return;
        const target = document.getElementById(id.slice(1));
        if (!target) return;
        event.preventDefault();
        lenis.scrollTo(target, { offset: -Math.min(72, window.innerHeight * 0.08), duration: 1.45 });
      });
    });
  }

  /* ──────────────────────────────────────────────────────────────
     Navigation + page progress
     ────────────────────────────────────────────────────────────── */

  const navEl = $('#nav');
  const pageBar = $('#pageProgress');

  function paintScrollUI() {
    const y = window.scrollY || window.pageYOffset;

    if (navEl) navEl.classList.toggle('is-scrolled', y > 28);

    if (pageBar) {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      pageBar.style.transform = `scaleX(${max > 0 ? clamp(y / max, 0, 1) : 0})`;
    }
  }

  /* ──────────────────────────────────────────────────────────────
     Hero clock + dial
     ────────────────────────────────────────────────────────────── */

  function buildDial() {
    const group = $('#dialTicks');
    if (!group) return;

    const NS = 'http://www.w3.org/2000/svg';
    const cx = 200;
    const cy = 200;

    for (let i = 0; i < 96; i += 1) {
      const angle = (i / 96) * Math.PI * 2 - Math.PI / 2;
      const major = i % 8 === 0;
      const mid = i % 4 === 0;
      const outer = 186;
      const inner = major ? 168 : mid ? 176 : 180;

      const line = document.createElementNS(NS, 'line');
      line.setAttribute('x1', String(cx + Math.cos(angle) * inner));
      line.setAttribute('y1', String(cy + Math.sin(angle) * inner));
      line.setAttribute('x2', String(cx + Math.cos(angle) * outer));
      line.setAttribute('y2', String(cy + Math.sin(angle) * outer));
      line.setAttribute('stroke', 'currentColor');
      line.setAttribute('stroke-width', major ? '1.5' : '1');
      line.setAttribute('opacity', major ? '0.85' : mid ? '0.45' : '0.22');
      group.appendChild(line);
    }

    const numerals = [
      [200, 50, '12'], [330, 200, '3'], [200, 355, '6'], [70, 200, '9'],
    ];
    numerals.forEach(([x, y, label]) => {
      const text = document.createElementNS(NS, 'text');
      text.setAttribute('x', String(x));
      text.setAttribute('y', String(y));
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('dominant-baseline', 'middle');
      text.setAttribute('fill', 'currentColor');
      text.setAttribute('font-family', "'JetBrains Mono', monospace");
      text.setAttribute('font-size', '9');
      text.setAttribute('letter-spacing', '2');
      text.setAttribute('opacity', '0.7');
      text.textContent = label;
      group.appendChild(text);
    });
  }

  function initClock() {
    const timeEl = $('#heroTime');
    const navClock = $('#navClock');
    const hourHand = $('#dialHour');
    const minuteHand = $('#dialMinute');
    const secondHand = $('#dialSecond');

    const pad = (n) => String(n).padStart(2, '0');

    const tick = () => {
      const d = new Date();
      const hh = d.getHours();
      const mm = d.getMinutes();
      const ss = d.getSeconds();

      const stamp = `${pad(hh)}:${pad(mm)}`;
      if (timeEl) timeEl.textContent = stamp;
      if (navClock) navClock.textContent = stamp;

      if (hourHand) hourHand.setAttribute('transform', `rotate(${((hh % 12) + mm / 60) * 30} 200 200)`);
      if (minuteHand) minuteHand.setAttribute('transform', `rotate(${(mm + ss / 60) * 6} 200 200)`);
      if (secondHand) secondHand.setAttribute('transform', `rotate(${ss * 6} 200 200)`);
    };

    tick();
    window.setInterval(tick, 1000);
  }

  /* ──────────────────────────────────────────────────────────────
     Custom cursor
     ────────────────────────────────────────────────────────────── */

  function initCursor() {
    if (!finePointer || reduceMotion) return;

    const root = $('#cursor');
    if (!root) return;

    const dot = $('.cursor__dot', root);
    const ring = $('.cursor__ring', root);

    let mx = window.innerWidth / 2;
    let my = window.innerHeight / 2;
    let dx = mx;
    let dy = my;
    let rx = mx;
    let ry = my;

    window.addEventListener('pointermove', (e) => {
      mx = e.clientX;
      my = e.clientY;
      root.classList.add('is-on');
    }, { passive: true });

    window.addEventListener('pointerdown', () => root.classList.add('is-down'));
    window.addEventListener('pointerup', () => root.classList.remove('is-down'));
    document.addEventListener('mouseleave', () => root.classList.remove('is-on'));

    const hoverables = 'a, button, .day__block, .how__row, .cell, .film__chapters > span';
    document.addEventListener('pointerover', (e) => {
      if (e.target.closest(hoverables)) root.classList.add('is-hover');
    });
    document.addEventListener('pointerout', (e) => {
      if (e.target.closest(hoverables)) root.classList.remove('is-hover');
    });

    const loop = () => {
      dx += (mx - dx) * 0.55;
      dy += (my - dy) * 0.55;
      rx += (mx - rx) * 0.16;
      ry += (my - ry) * 0.16;
      if (dot) dot.style.transform = `translate3d(${dx}px, ${dy}px, 0) translate(-50%, -50%)`;
      if (ring) ring.style.transform = `translate3d(${rx}px, ${ry}px, 0) translate(-50%, -50%)`;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  /* ──────────────────────────────────────────────────────────────
     The film — canvas drawing helpers
     ────────────────────────────────────────────────────────────── */

  const FILM = {
    canvas: null,
    ctx: null,
    section: null,
    w: 0,
    h: 0,
    dpr: 1,
    top: 0,
    height: 0,
    progress: 0,
    target: 0,
  };

  const CAPTION_BOUNDS = [
    [0.0, 0.25],
    [0.25, 0.5],
    [0.5, 0.75],
    [0.75, 1.0],
  ];

  /* A Tuesday, 06:00 → 24:00. Times are decimal hours. */
  const DAY = [
    { s: 6.75, e: 7.5, lane: -1, label: 'Morning pages' },
    { s: 7.5, e: 8.25, lane: 1, label: 'Run' },
    { s: 8.5, e: 9.0, lane: -1, label: 'Breakfast' },
    { s: 9.0, e: 10.5, lane: -1, label: 'Deep work' },
    { s: 10.75, e: 11.0, lane: 1, label: 'Stand-up' },
    { s: 11.0, e: 12.25, lane: -1, label: 'Deep work II' },
    { s: 12.5, e: 13.25, lane: 1, label: 'Lunch' },
    { s: 13.5, e: 14.5, lane: -1, label: 'Reading' },
    { s: 14.5, e: 15.25, lane: 1, label: 'Admin' },
    { s: 16.0, e: 17.0, lane: -1, label: 'Gym' },
    { s: 18.0, e: 19.0, lane: 1, label: 'Dinner' },
    { s: 20.0, e: 20.5, lane: -1, label: 'Journal' },
    { s: 21.0, e: 22.0, lane: 1, label: 'Wind down' },
  ];

  const NOW_HOUR = 10.07;

  function roundRect(ctx, x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  function canvasSize() {
    const { canvas, ctx } = FILM;
    if (!canvas || !ctx) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    FILM.w = rect.width;
    FILM.h = rect.height;
    FILM.dpr = dpr;

    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function measureFilm() {
    const { section } = FILM;
    if (!section) return;
    const rect = section.getBoundingClientRect();
    FILM.top = rect.top + (window.scrollY || window.pageYOffset);
    FILM.height = section.offsetHeight;
    canvasSize();
  }

  /* ── Act I — the day ring ─────────────────────────────────────── */

  function drawRing(p, alpha, time) {
    const ctx = FILM.ctx;
    const w = FILM.w;
    const h = FILM.h;
    const cx = w / 2;
    const cy = h * 0.5 - h * 0.015;
    const base = Math.min(w, h) * 0.285;
    const R = clamp(base, 150, 340);
    const appear = smooth(0.0, 0.075, p);
    const build = smooth(0.015, 0.2, p);

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(cx, cy);
    ctx.scale(0.92 + appear * 0.08, 0.92 + appear * 0.08);

    /* slow rotation keeps the dial alive even when the scroll is still */
    const drift = reduceMotion ? 0 : Math.sin(time * 0.00012) * 0.05;
    ctx.rotate(drift);

    /* outer hairline */
    ctx.beginPath();
    ctx.arc(0, 0, R + 22, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255,255,255,${0.1 * appear})`;
    ctx.lineWidth = 1;
    ctx.stroke();

    /* ticks like the hero dial */
    for (let i = 0; i < 96; i += 1) {
      const a = (i / 96) * Math.PI * 2 - Math.PI / 2;
      const major = i % 8 === 0;
      const mid = i % 4 === 0;
      const inner = R - (major ? 24 : mid ? 16 : 10);
      const seen = clamp((appear - i / 96 * 0.35) / 0.65, 0, 1);

      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * inner, Math.sin(a) * inner);
      ctx.lineTo(Math.cos(a) * (R + 6), Math.sin(a) * (R + 6));
      ctx.strokeStyle = `rgba(255,255,255,${(major ? 0.38 : mid ? 0.2 : 0.1) * seen})`;
      ctx.lineWidth = major ? 1.8 : mid ? 1.2 : 1;
      ctx.stroke();
    }

    /* the blocks of the day, drawn as arcs around the dial - like grid blocks */
    const radius = R - 2;
    DAY.forEach((block, i) => {
      const t0 = (block.s - 6) / 18;
      const t1 = (block.e - 6) / 18;
      const grow = clamp((build - i * 0.035) / 0.55, 0, 1);
      if (grow <= 0) return;

      const a0 = t0 * Math.PI * 2 - Math.PI / 2;
      const a1 = (t0 + (t1 - t0) * grow) * Math.PI * 2 - Math.PI / 2;

      ctx.beginPath();
      ctx.arc(0, 0, radius, a0, a1);
      if (block.lane === -1) {
        ctx.strokeStyle = `rgba(255,255,255,${0.94 * grow})`;
        ctx.lineWidth = 16;
      } else {
        ctx.strokeStyle = `rgba(255,255,255,${0.28 * grow})`;
        ctx.lineWidth = 10;
      }
      ctx.lineCap = 'butt';
      ctx.stroke();
      
      // subtle outline for filled blocks
      if (block.lane === -1 && grow > 0.5) {
        ctx.beginPath();
        ctx.arc(0, 0, radius + 0.5, a0, a1);
        ctx.strokeStyle = `rgba(255,255,255,${0.18 * grow})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    });

    /* the now mark */
    const nowAngle = ((NOW_HOUR - 6) / 18) * Math.PI * 2 - Math.PI / 2;
    const nR = R - 2;
    const nx = Math.cos(nowAngle) * nR;
    const ny = Math.sin(nowAngle) * nR;

    ctx.beginPath();
    ctx.arc(nx, ny, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,255,255,${0.95 * appear})`;
    ctx.fill();

    const pulse = reduceMotion ? 1 : 1 + Math.sin(time * 0.0022) * 0.18;
    ctx.beginPath();
    ctx.arc(nx, ny, 13 * pulse, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255,255,255,${0.24 * appear})`;
    ctx.lineWidth = 1;
    ctx.stroke();

    /* centre readout */
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = `rgba(255,255,255,${0.5 * appear})`;
    ctx.font = '400 9.5px "JetBrains Mono", monospace';
    ctx.fillText('24 HOURS', 0, -10);
    ctx.fillStyle = `rgba(255,255,255,${0.22 * appear})`;
    ctx.font = '400 8px "JetBrains Mono", monospace';
    ctx.fillText('ONE DAY', 0, 8);

    ctx.restore();
  }

  /* ── Act II — the day score (planner grid style) ───────────────── */

  function drawTimeline(p, alpha) {
    const ctx = FILM.ctx;
    const w = FILM.w;
    const h = FILM.h;
    const grow = smooth(0.24, 0.43, p);
    
    // Match planner grid proportions
    const gridW = Math.min(w * 0.88, 1400);
    const gridH = Math.min(h * 0.52, 380);
    const gridX = (w - gridW) / 2;
    const gridY = (h - gridH) / 2;
    const gap = 12;
    const colW = (gridW - gap) / 2;
    
    const from = 6;
    const to = 24;
    const span = to - from;
    const slotH = gridH / 48; // 30 min slots like planner
    
    ctx.save();
    ctx.globalAlpha = alpha;

    // Column headers like in planner
    ctx.font = '400 10px "JetBrains Mono", monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('MORNING • AFTERNOON', gridX + 46, gridY - 18);
    ctx.fillText('EVENING • NIGHT', gridX + colW + gap + 46, gridY - 18);
    
    ctx.font = '400 8px "JetBrains Mono", monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    ctx.textAlign = 'right';
    ctx.fillText('12 AM — 12 PM', gridX + colW - 4, gridY - 16);
    ctx.fillText('12 PM — 12 AM', gridX + gridW - 4, gridY - 16);
    
    // Draw two columns
    for (let col = 0; col < 2; col++) {
      const colX = gridX + col * (colW + gap);
      const gutterW = 38;
      
      // Column header bottom border
      ctx.beginPath();
      ctx.moveTo(colX, gridY - 6);
      ctx.lineTo(colX + colW, gridY - 6);
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 1;
      ctx.stroke();
      
      // Gutter
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(colX + gutterW, gridY);
      ctx.lineTo(colX + gutterW, gridY + gridH);
      ctx.stroke();
      
      // Hour markers in gutter
      for (let hour = from; hour <= to; hour += 1) {
        const y = gridY + ((hour - from) / span) * gridH;
        if (hour % 2 === 0) {
          ctx.font = '400 8px "JetBrains Mono", monospace';
          ctx.fillStyle = hour % 6 === 0 ? 'rgba(255,255,255,0.32)' : 'rgba(255,255,255,0.18)';
          ctx.textAlign = 'right';
          ctx.textBaseline = 'middle';
          ctx.fillText(`${String(hour).padStart(2, '0')}`, colX + gutterW - 6, y);
        }
        // Hour lines
        ctx.beginPath();
        ctx.moveTo(colX + gutterW, y);
        ctx.lineTo(colX + colW, y);
        ctx.strokeStyle = hour % 6 === 0 ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.04)';
        ctx.lineWidth = hour % 6 === 0 ? 1 : 0.5;
        ctx.stroke();
      }
      
      // Vertical grid lines
      ctx.beginPath();
      ctx.moveTo(colX + gutterW + 12, gridY);
      ctx.lineTo(colX + gutterW + 12, gridY + gridH);
      ctx.strokeStyle = 'rgba(255,255,255,0.03)';
      ctx.lineWidth = 0.5;
      ctx.stroke();
    }
    
    // Outer border
    roundRect(ctx, gridX, gridY, gridW, gridH, 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.stroke();
    
    // Blocks - styled like planner blocks
    DAY.forEach((block, i) => {
      const isAM = block.s < 12;
      const col = isAM ? 0 : 1;
      const colX = gridX + col * (colW + gap);
      const gutterW = 38;
      const trackX = colX + gutterW + 8;
      const trackW = colW - gutterW - 12;
      
      const y0 = gridY + ((block.s - from) / span) * gridH;
      const bh = ((block.e - block.s) / span) * gridH * grow;
      if (bh < 1) return;
      
      const r = 2;
      roundRect(ctx, trackX, y0, trackW, Math.max(bh, 4), r);
      
      if (block.lane === -1) {
        // Filled block like study/rest in planner
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.08)';
        ctx.lineWidth = 0.5;
        roundRect(ctx, trackX + 0.5, y0 + 0.5, trackW - 1, Math.max(bh - 1, 3), r - 0.5);
        ctx.stroke();
      } else {
        // Outlined/alt block
        ctx.fillStyle = 'rgba(255,255,255,0.04)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.38)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      
      // Label
      if (bh > 16 && grow > 0.7 && trackW > 40) {
        ctx.save();
        ctx.font = '400 7.5px "JetBrains Mono", monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        if (block.lane === -1) {
          ctx.fillStyle = 'rgba(0,0,0,0.85)';
        } else {
          ctx.fillStyle = 'rgba(255,255,255,0.72)';
        }
        const label = block.label.toUpperCase();
        ctx.fillText(label.length > 16 ? label.slice(0, 14) + '…' : label, trackX + 8, y0 + bh / 2);
        ctx.restore();
      }
      
      // Now indicator
      if (block.s <= NOW_HOUR && block.e > NOW_HOUR && grow > 0.9) {
        ctx.save();
        ctx.shadowColor = block.lane === -1 ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.4)';
        ctx.shadowBlur = 16;
        if (block.lane === -1) {
          ctx.fillStyle = 'rgba(255,255,255,0.98)';
          ctx.fill();
        } else {
          ctx.strokeStyle = 'rgba(255,255,255,0.6)';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
        ctx.restore();
      }
    });
    
    // Now line across both columns
    const nowY = gridY + ((NOW_HOUR - from) / span) * gridH;
    const nowSeen = smooth(0.3, 0.4, p);
    ctx.beginPath();
    ctx.moveTo(gridX + 4, nowY);
    ctx.lineTo(gridX + gridW - 4, nowY);
    ctx.strokeStyle = `rgba(255,255,255,${0.6 * nowSeen})`;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    
    ctx.beginPath();
    ctx.arc(gridX + 4, nowY, 3.6, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,255,255,${0.98 * nowSeen})`;
    ctx.fill();
    
    ctx.font = '400 7.5px "JetBrains Mono", monospace';
    ctx.fillStyle = `rgba(255,255,255,${0.68 * nowSeen})`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('NOW', gridX + 12, nowY);

    ctx.restore();
  }

  /* ── Act III — the one thing ──────────────────────────────────── */

  function drawFocus(p, alpha, time) {
    const ctx = FILM.ctx;
    const w = FILM.w;
    const h = FILM.h;
    const local = smooth(0.5, 0.7, p);

    const cw = Math.min(w * 0.74, 760);
    const ch = Math.min(h * 0.52, 380);
    const cx = w / 2;
    const cy = h * 0.5;
    const left = cx - cw / 2;
    const top = cy - ch / 2;
    const scale = 0.94 + local * 0.06;

    ctx.save();
    ctx.globalAlpha = alpha;

    /* dimmed day score behind the glass */
    ctx.save();
    ctx.globalAlpha = alpha * (0.18 + local * 0.08);
    drawTimeline(0.5, 1);
    ctx.restore();

    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    ctx.translate(-cx, -cy);

    /* glass card */
    ctx.fillStyle = 'rgba(0,0,0,0.82)';
    roundRect(ctx, left, top, cw, ch, 2);
    ctx.fill();

    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1;
    roundRect(ctx, left, top, cw, ch, 2);
    ctx.stroke();

    /* corner framing marks */
    const b = 16;
    const o = 12;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1.4;
    const corners = [
      [left - o, top - o, b, 0, 0, b],
      [left + cw + o, top - o, -b, 0, 0, b],
      [left - o, top + ch + o, b, 0, 0, -b],
      [left + cw + o, top + ch + o, -b, 0, 0, -b],
    ];
    corners.forEach(([x, y, ax, ay, bx, by]) => {
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + ax, y + ay);
      ctx.moveTo(x, y);
      ctx.lineTo(x + bx, y + by);
      ctx.stroke();
    });

    /* meta line */
    const pad = 34;
    ctx.font = '400 8.5px "JetBrains Mono", monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillText('BLOCK 04', left + pad, top + pad);
    ctx.textAlign = 'right';
    ctx.fillText('07 TOTAL', left + cw - pad, top + pad);

    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath();
    ctx.moveTo(left + pad, top + pad + 20);
    ctx.lineTo(left + cw - pad, top + pad + 20);
    ctx.stroke();

    /* timer ring, bottom right of the card */
    const ringR = Math.min(ch * 0.19, 62);
    const ringX = left + cw - pad - ringR;
    const ringY = top + ch - pad - ringR;
    const sweep = 0.42 + local * 0.45;

    ctx.beginPath();
    ctx.arc(ringX, ringY, ringR, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(ringX, ringY, ringR, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * sweep);
    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(ringX, ringY, 3.2, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fill();

    ctx.font = '400 7.5px "JetBrains Mono", monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.textAlign = 'center';
    ctx.fillText('FOCUS', ringX, ringY + ringR + 20);

    /* progress rail */
    const railW = cw - pad * 2 - ringR * 2 - 24;
    const railY = top + ch - pad - 22;
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath();
    ctx.moveTo(left + pad, railY);
    ctx.lineTo(left + pad + railW, railY);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(left + pad, railY);
    ctx.lineTo(left + pad + railW * sweep, railY);
    ctx.stroke();

    /* little ticks under the rail */
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 28; i += 1) {
      const tx = left + pad + (railW / 28) * i;
      ctx.beginPath();
      ctx.moveTo(tx, railY + 9);
      ctx.lineTo(tx, railY + (i % 7 === 0 ? 17 : 13));
      ctx.stroke();
    }

    /* breathing dot in the card's quiet space */
    const breath = reduceMotion ? 1 : 0.55 + Math.sin(time * 0.0018) * 0.45;
    ctx.beginPath();
    ctx.arc(left + pad + 5, top + ch - pad - 70, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,255,255,${0.35 + breath * 0.5})`;
    ctx.fill();

    ctx.restore();
  }

  /* ── Act IV — the cadence line ────────────────────────────────── */

  function drawWave(p, alpha, time) {
    const ctx = FILM.ctx;
    const w = FILM.w;
    const h = FILM.h;
    const cy = h * 0.5;
    const local = smooth(0.75, 0.9, p);
    const amplitude = Math.min(w, h) * 0.055 * local;
    const span = Math.min(w * 0.86, 1300);
    const x0 = (w - span) / 2;
    const phase = reduceMotion ? 0 : time * 0.00045;

    ctx.save();
    ctx.globalAlpha = alpha;

    /* horizon */
    ctx.beginPath();
    ctx.moveTo(x0, cy);
    ctx.lineTo(x0 + span, cy);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.stroke();

    /* three layered waves */
    const layers = [
      { amp: 1, alpha: 0.9, width: 1.6, speed: 1 },
      { amp: 0.55, alpha: 0.3, width: 1, speed: -0.7 },
      { amp: 0.28, alpha: 0.16, width: 1, speed: 1.7 },
    ];

    layers.forEach((layer) => {
      ctx.beginPath();
      for (let x = 0; x <= span; x += 2) {
        const u = x / span;
        const envelope = Math.sin(u * Math.PI);
        const wave =
          Math.sin(u * Math.PI * 7 + phase * layer.speed) * 0.72 +
          Math.sin(u * Math.PI * 13 + phase * layer.speed * 0.6) * 0.24;

        const y = cy + wave * amplitude * envelope * layer.amp;
        if (x === 0) ctx.moveTo(x0 + x, y);
        else ctx.lineTo(x0 + x, y);
      }
      ctx.strokeStyle = `rgba(255,255,255,${layer.alpha})`;
      ctx.lineWidth = layer.width;
      ctx.stroke();
    });

    /* beat dots sitting on the horizon */
    const beats = 13;
    for (let i = 0; i < beats; i += 1) {
      const u = i / (beats - 1);
      const x = x0 + u * span;
      const seen = clamp((local - u * 0.4) / 0.6, 0, 1);
      const pulse = reduceMotion ? 1 : 1 + Math.sin(time * 0.002 + i) * 0.25;

      ctx.beginPath();
      ctx.arc(x, cy, 2.4 * pulse, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${0.7 * seen})`;
      ctx.fill();
    }

    ctx.font = '400 8.5px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = `rgba(255,255,255,${0.34 * local})`;
    ctx.fillText('ONE THING AT A TIME', w / 2, cy + Math.min(h * 0.16, 120));

    ctx.restore();
  }

  /* ── The film loop ────────────────────────────────────────────── */

  function renderFilm(p, time) {
    const ctx = FILM.ctx;
    if (!ctx || FILM.w === 0) return;

    ctx.clearRect(0, 0, FILM.w, FILM.h);

    const aRing = 1 - smooth(0.19, 0.28, p);
    const aTimeline = smooth(0.19, 0.28, p) * (1 - smooth(0.44, 0.53, p));
    const aFocus = smooth(0.44, 0.53, p) * (1 - smooth(0.69, 0.78, p));
    const aWave = smooth(0.69, 0.78, p);

    if (aRing > 0.002) drawRing(p, aRing, time);
    if (aTimeline > 0.002) drawTimeline(p, aTimeline);
    if (aFocus > 0.002) drawFocus(p, aFocus, time);
    if (aWave > 0.002) drawWave(p, aWave, time);
  }

  const filmEls = {
    captions: [],
    now: null,
    chapters: [],
    bar: null,
    timecode: null,
  };

  function paintFilmUI(p) {
    filmEls.captions.forEach((el, i) => {
      const [start, end] = CAPTION_BOUNDS[i];
      const fadeIn = i === 0 ? 1 : smooth(start, start + 0.045, p);
      const fadeOut = i === CAPTION_BOUNDS.length - 1 ? 1 : 1 - smooth(end - 0.045, end, p);
      const alpha = Math.min(fadeIn, fadeOut);

      el.style.opacity = alpha.toFixed(3);
      el.style.transform = `translate3d(0, ${((1 - alpha) * 22).toFixed(2)}px, 0)`;
      el.style.visibility = alpha < 0.01 ? 'hidden' : 'visible';
    });

    if (filmEls.now) {
      const alpha = smooth(0.51, 0.58, p) * (1 - smooth(0.69, 0.75, p));
      filmEls.now.style.opacity = alpha.toFixed(3);
    }

    filmEls.chapters.forEach((el, i) => {
      const [start, end] = CAPTION_BOUNDS[i];
      const isOn = p >= start && (i === 3 ? p <= 1.001 : p < end);
      el.classList.toggle('is-on', isOn);
      if (el.setAttribute) {
        el.setAttribute('aria-selected', isOn ? 'true' : 'false');
      }
    });

    if (filmEls.bar) filmEls.bar.style.transform = `scaleX(${p})`;

    if (filmEls.timecode) {
      const minutes = 6 * 60 + p * 18 * 60;
      const hh = Math.floor(minutes / 60);
      const mm = Math.floor(minutes % 60);
      filmEls.timecode.textContent = `${String(Math.min(hh, 24)).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    }
  }

  function initFilm() {
    FILM.canvas = $('#filmCanvas');
    FILM.section = $('#film');
    if (!FILM.canvas || !FILM.section) return;

    try {
      FILM.ctx = FILM.canvas.getContext('2d', { alpha: true });
    } catch (e) {
      FILM.ctx = null;
    }
    if (!FILM.ctx) return;

    filmEls.captions = $$('.film__caption');
    filmEls.now = $('#filmNow');
    filmEls.chapters = $$('.film__chapters > span');
    filmEls.bar = $('#filmBar');
    filmEls.timecode = $('#filmTimecode');

    measureFilm();
    paintFilmUI(0);

    let lastTime = 0;
    const loop = (time) => {
      const y = window.scrollY || window.pageYOffset;
      const span = Math.max(1, FILM.height - window.innerHeight);
      const target = clamp((y - FILM.top) / span, 0, 1);

      if (reduceMotion) {
        FILM.progress = target;
      } else {
        /* the heavy, video-like scrub */
        FILM.progress += (target - FILM.progress) * 0.13;
        if (Math.abs(target - FILM.progress) < 0.0002) FILM.progress = target;
      }

      /* only do the expensive work when the stage is on screen */
      const onScreen = y + window.innerHeight > FILM.top - window.innerHeight * 0.2 && y < FILM.top + FILM.height + window.innerHeight * 0.2;
      if (onScreen) {
        renderFilm(FILM.progress, time);
        paintFilmUI(FILM.progress);
      }

      requestAnimationFrame(loop);
    };

    requestAnimationFrame(loop);

    let resizeTimer = null;
    window.addEventListener('resize', () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        measureFilm();
        renderFilm(FILM.progress, performance.now());
      }, 100);
    }, { passive: true });

    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => {
        measureFilm();
        renderFilm(FILM.progress, performance.now());
      }).catch(() => {});
    }
  }

  /* ──────────────────────────────────────────────────────────────
     Manifesto: word-by-word illumination
     ────────────────────────────────────────────────────────────── */

  let manifestoWords = [];
  let manifestoEl = null;

  function splitWords(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => (node.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });

    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    textNodes.forEach((node) => {
      const parts = node.textContent.split(/(\s+)/);
      const frag = document.createDocumentFragment();

      parts.forEach((part) => {
        if (!part) return;
        if (/^\s+$/.test(part)) {
          frag.appendChild(document.createTextNode(part));
        } else {
          const span = document.createElement('span');
          span.className = 'w';
          span.textContent = part;
          frag.appendChild(span);
        }
      });

      node.replaceWith(frag);
    });

    return $$('.w', root);
  }

  function initManifesto() {
    manifestoEl = $('#manifestoText');
    if (!manifestoEl) return;
    manifestoWords = splitWords(manifestoEl);
    manifestoWords.forEach((w) => { w.style.color = '#757575'; w.style.opacity = '1'; });
    if (reduceMotion) manifestoWords.forEach((w) => { w.style.color = '#bfbfbf'; w.style.opacity = '1'; });
  }

  function paintManifesto() {
    if (!manifestoEl || !manifestoWords.length || reduceMotion) return;

    const rect = manifestoEl.getBoundingClientRect();
    if (rect.bottom < -80 || rect.top > window.innerHeight + 80) return;

    const start = window.innerHeight * 0.82;
    const travelled = start - rect.top;
    const total = rect.height + window.innerHeight * 0.24;
    const progress = clamp(travelled / total, 0, 1);
    const lit = progress * manifestoWords.length * 1.18;

    manifestoWords.forEach((word, i) => {
      const v = clamp((lit - i) / 2.6, 0, 1);
      const c = Math.round(117 + v * 138);
      word.style.color = `rgb(${c}, ${c}, ${c})`;
    });
  }

  /* ──────────────────────────────────────────────────────────────
     Reveals
     ────────────────────────────────────────────────────────────── */

  function initReveals() {
    const nodes = $$('.reveal');

    if (reduceMotion || !('IntersectionObserver' in window)) {
      nodes.forEach((node) => node.classList.add('in-view'));
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('in-view');
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.1, rootMargin: '0px 0px -8% 0px' });

    nodes.forEach((node) => observer.observe(node));
  }

  /* ──────────────────────────────────────────────────────────────
     The day board
     ────────────────────────────────────────────────────────────── */

  function initDay() {
    const track0 = $('#dayTrack0');
    const track1 = $('#dayTrack1');
    const gutter0 = $('#dayGutter0');
    const gutter1 = $('#dayGutter1');
    const board = $('.day__board');
    if (!track0 || !track1 || !gutter0 || !gutter1) return;

    const from = 6;
    const to = 24;
    const span = to - from;

    const fmt = (hour) => {
      const h = Math.floor(hour);
      const m = Math.round((hour - h) * 60);
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    };

    // Build gutters
    for (let hour = from; hour <= to; hour += 0.5) {
      const el = document.createElement('span');
      el.className = 'day__gutter-hour' + (hour % 1 === 0 && hour % 2 === 0 ? ' is-hour' : '');
      el.style.gridRow = String(Math.round((hour - from) * 2 + 1));
      if (hour % 1 === 0 && hour % 2 === 0) {
        el.textContent = `${String(hour).padStart(2, '0')}:00`;
      }
      gutter0.appendChild(el.cloneNode(true));
      gutter1.appendChild(el);
    }

    DAY.forEach((block, i) => {
      const track = block.s < 12 ? track0 : track1;
      const el = document.createElement('div');
      const hPct = ((block.e - block.s) / span) * 100;

      el.className = 'day__block' + (block.lane === 1 ? ' is-alt' : '') +
        (block.s <= NOW_HOUR && block.e > NOW_HOUR ? ' is-now' : '') +
        (hPct < 6 ? ' is-narrow' : '');

      el.style.top = `${((block.s - from) / span) * 100}%`;
      el.style.height = `${hPct}%`;
      el.style.setProperty('--i', String(i));
      el.dataset.time = `${fmt(block.s)} – ${fmt(block.e)}`;
      el.innerHTML = `<span>${block.label}</span>`;
      el.title = `${block.label} · ${fmt(block.s)}–${fmt(block.e)}`;
      track.appendChild(el);
    });

    const now0 = document.createElement('div');
    now0.className = 'day__now';
    now0.style.top = `${((NOW_HOUR - from) / span) * 100}%`;
    now0.innerHTML = '<span>NOW</span>';
    track0.appendChild(now0);

    const now1 = document.createElement('div');
    now1.className = 'day__now';
    now1.style.top = `${((NOW_HOUR - from) / span) * 100}%`;
    now1.innerHTML = '<span>NOW</span>';
    track1.appendChild(now1);

    if (board) {
      if (reduceMotion || !('IntersectionObserver' in window)) {
        board.classList.add('is-live');
      } else {
        const observer = new IntersectionObserver((entries) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            board.classList.add('is-live');
            observer.disconnect();
          });
        }, { threshold: 0.25 });
        observer.observe(board);
      }
    }
  }

  /* ──────────────────────────────────────────────────────────────
     Hero dial parallax + the single rAF that ties it together
     ────────────────────────────────────────────────────────────── */

  function initFrameLoop() {
    const dial = $('#heroDial');
    const grain = $('.grain');

    const loop = () => {
      const y = window.scrollY || window.pageYOffset;

      if (dial) {
        const shift = Math.min(y, window.innerHeight * 1.4);
        dial.style.transform = `translate3d(0, ${shift * 0.1}px, 0) rotate(${shift * 0.012}deg)`;
      }

      if (grain && !reduceMotion) {
        grain.style.transform = `translate3d(${Math.sin(y * 0.006) * 8}px, ${Math.cos(y * 0.004) * 8}px, 0)`;
      }

      paintManifesto();
      paintScrollUI();

      requestAnimationFrame(loop);
    };

    requestAnimationFrame(loop);

    window.addEventListener('resize', () => {
      paintScrollUI();
      paintManifesto();
    }, { passive: true });
  }

  /* ──────────────────────────────────────────────────────────────
     Go
     ────────────────────────────────────────────────────────────── */

  function start() {
    boot();
    initScroll();
    buildDial();
    initClock();
    initCursor();
    initFilm();
    initManifesto();
    initReveals();
    initDay();
    initFrameLoop();
    paintScrollUI();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
