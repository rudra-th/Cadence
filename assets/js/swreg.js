/**
 * Cadence — service worker registration, shared by every page.
 *
 * The landing, the planner and the clock all reach this script, so an install
 * or an update is never tied to which page the person happened to be on. When
 * a new worker has finished installing in the background, a small toast offers
 * "Reload now" — telling the person to "reopen the app" meant a force-kill on
 * iOS, which nobody does.
 */
(function () {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol === 'file:') return;

  // Set only when the person accepts the reload; the controller change that
  // follows is then this same handover, not a first install.
  let refreshing = false;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!refreshing) return;
    location.reload();
  });

  navigator.serviceWorker.register('./sw.js', { scope: './' }).then((reg) => {
    const announce = () => {
      // Without a controller this is the very first install, not an update.
      if (navigator.serviceWorker.controller) showUpdateToast(reg);
    };
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      if (!sw) return;
      sw.addEventListener('statechange', () => {
        if (sw.state === 'installed') announce();
      });
    });
    if (reg.waiting && navigator.serviceWorker.controller) announce();
  }).catch((err) => {
    console.warn('[Cadence] service worker registration failed', err);
  });

  function showUpdateToast(reg) {
    const bar = document.createElement('div');
    bar.setAttribute('role', 'status');
    bar.setAttribute('aria-live', 'polite');
    bar.style.cssText = 'position:fixed;left:50%;bottom:max(16px, env(safe-area-inset-bottom, 16px));transform:translateX(-50%);'
      + 'z-index:2000;display:flex;align-items:center;gap:12px;padding:10px 14px 10px 16px;background:#161616;color:#fff;'
      + 'border:1px solid #2e2e2e;border-radius:10px;font:500 13px/1.4 system-ui, -apple-system, sans-serif;'
      + 'box-shadow:0 10px 34px rgba(0,0,0,.5);max-width:calc(100vw - 24px);';

    const msg = document.createElement('span');
    msg.textContent = 'Update ready';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Reload now';
    btn.style.cssText = 'font:600 13px/1.4 system-ui, -apple-system, sans-serif;background:#fff;color:#000;'
      + 'border:0;border-radius:7px;padding:7px 12px;cursor:pointer;white-space:nowrap;';
    btn.addEventListener('click', () => {
      refreshing = true;
      reg.waiting?.postMessage({ type: 'SKIP_WAITING' });
      // If the handover message never lands, reload anyway rather than strand
      // the person on a stale page.
      setTimeout(() => { if (refreshing) location.reload(); }, 2500);
    });

    bar.append(msg, btn);
    document.body.appendChild(bar);
    setTimeout(() => bar.remove(), 20000);
  }
})();
