/**
 * Cadence — the theme.
 *
 * Two monochrome palettes, nothing else. The choice is stored with the rest
 * of the app, so it follows the user from the landing page to the workspace
 * and survives a reload, an install, and a flight with the network off.
 *
 * The page sets `data-theme` on <html> before the first paint (see the small
 * inline script in the head of each page) so the app never flashes the wrong
 * palette on the way in.
 */

const STORE_KEY = 'cadence.store.v1';

export const THEMES = ['void', 'graphite'];

export const THEME_LABELS = {
  void: 'Void',
  graphite: 'Graphite',
};

/** The theme saved in the store, or the default. */
export function readTheme() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return 'void';
    const parsed = JSON.parse(raw);
    const theme = parsed?.settings?.theme;
    return THEMES.includes(theme) ? theme : 'void';
  } catch {
    return 'void';
  }
}

/**
 * Save the theme without disturbing anything else in the store.
 *
 * The landing page has no reason to load the whole store, and the workspace
 * may hold unsaved changes — so only the one field is touched.
 */
export function writeTheme(name) {
  const next = THEMES.includes(name) ? name : 'void';
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object') parsed = {};
    parsed.settings = { ...(parsed.settings || {}), theme: next };
    localStorage.setItem(STORE_KEY, JSON.stringify(parsed));
  } catch {
    /* private mode — the theme simply will not persist */
  }
  return next;
}

/** Put a theme on the page. */
export function applyTheme(name) {
  const next = THEMES.includes(name) ? name : 'void';
  document.documentElement.dataset.theme = next;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', next === 'graphite' ? '#0B0B0B' : '#000000');
  return next;
}

/** Read the saved theme and put it on the page. */
export function initTheme() {
  return applyTheme(readTheme());
}

/**
 * Flip between the two palettes and remember the choice.
 * Used by the toggle on the landing page and by the drawer's theme picker.
 */
export function cycleTheme(current) {
  const index = THEMES.indexOf(current);
  const next = THEMES[(index + 1) % THEMES.length];
  applyTheme(next);
  writeTheme(next);
  return next;
}
