/**
 * Cadence — the landing page.
 *
 * Small on purpose: the palette toggle has to work before the app is ever
 * opened, and the install prompt has to be there when the browser offers it.
 */

import { readTheme, writeTheme, applyTheme, THEMES, THEME_LABELS } from './theme.js';

const $ = (id) => document.getElementById(id);

/* ── The palette toggle ───────────────────────────────────── */

function paintThemeButton(theme) {
  const label = $('themeLabel');
  if (label) label.textContent = THEME_LABELS[theme] || 'Void';
}

function bindThemeToggle() {
  const btn = $('themeToggle');
  if (!btn) return;
  let theme = readTheme();
  applyTheme(theme);
  paintThemeButton(theme);

  btn.addEventListener('click', () => {
    const index = THEMES.indexOf(theme);
    theme = THEMES[(index + 1) % THEMES.length];
    applyTheme(theme);
    writeTheme(theme);
    paintThemeButton(theme);
  });
}

/* ── A live clock in the preview ──────────────────────────── */

function bindPreviewClock() {
  const clock = $('previewClock');
  const date = $('previewDate');
  if (!clock) return;

  const pad = (n) => String(n).padStart(2, '0');

  const paint = () => {
    const d = new Date();
    const h24 = d.getHours();
    const h = h24 % 12 === 0 ? 12 : h24 % 12;
    clock.textContent = `${h}:${pad(d.getMinutes())}`;
    if (date) {
      date.textContent = d.toLocaleDateString('en-US', {
        weekday: 'long', day: 'numeric', month: 'long',
      }) + ' · ' + (h24 < 12 ? 'AM' : 'PM');
    }
  };

  paint();
  setInterval(paint, 1000);
}

/* ── Install ──────────────────────────────────────────────── */

let deferredInstall = null;

function bindInstall() {
  const btn = $('installLandingBtn');
  if (!btn) return;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    btn.hidden = false;
  });

  btn.addEventListener('click', async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    const res = await deferredInstall.userChoice;
    if (res.outcome === 'accepted') btn.hidden = true;
    deferredInstall = null;
  });

  window.addEventListener('appinstalled', () => {
    btn.hidden = true;
  });
}

/* ── Version ──────────────────────────────────────────────── */

function paintVersion() {
  const el = $('landingVersion');
  if (!el) return;
  fetch('./manifest.webmanifest')
    .then(r => (r.ok ? r.json() : null))
    .then(m => { if (m && m.version) el.textContent = m.version; })
    .catch(() => { /* the manifest is optional here */ });
}

/* ── Scroll animations ───────────────────────────────────── */

function initScrollAnimations() {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.style.opacity = '1';
        entry.target.style.transform = 'translateY(0)';
      }
    });
  }, { threshold: 0.1, rootMargin: '0px 0px -50px 0px' });

  document.querySelectorAll('.feature, .step, .local__item').forEach(el => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(30px)';
    el.style.transition = 'opacity 0.8s ease-out, transform 0.8s ease-out';
    observer.observe(el);
  });
}

/* ── Go ────────────────────────────────────────────────────── */

bindThemeToggle();
bindPreviewClock();
bindInstall();
paintVersion();
initScrollAnimations();
