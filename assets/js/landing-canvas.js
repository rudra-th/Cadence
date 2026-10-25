/**
 * Cadence — Award-level frame-sequence scrollytelling
 * GSAP ScrollTrigger + Lenis + Canvas frame scrubbing
 */

import * as gsap from 'https://unpkg.com/gsap@3.12.5/index.js';
import { ScrollTrigger } from 'https://unpkg.com/gsap@3.12.5/ScrollTrigger.js';

gsap.registerPlugin(ScrollTrigger);

const canvas = document.getElementById('frameCanvas');
const ctx = canvas.getContext('2d', { alpha: false });
const preloader = document.getElementById('preloader');
const preloaderBar = document.getElementById('preloaderBar');
const preloaderPct = document.getElementById('preloaderPct');
const scrollProgress = document.getElementById('scrollProgress');
const soundToggle = document.getElementById('soundToggle');
const cursorDot = document.getElementById('cursorDot');
const cursorTrail = document.getElementById('cursorTrail');
const exploreBtn = document.getElementById('exploreBtn');
const frameStage = document.querySelector('.frame-stage');
const fallbackVideo = document.querySelector('.frame-stage__video');

const FRAME_COUNT = 120;
const frames = [];
let imagesLoaded = 0;
let currentFrame = 0;
let targetFrame = 0;
let rafId = null;
let useFallback = false;
let preloaderHidden = false;

function setCanvasSize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 1.6);
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  canvas.style.width = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawFrame(frameIndex) {
  if (useFallback) return;
  const img = frames[frameIndex];
  if (!img) return;
  const cw = window.innerWidth;
  const ch = window.innerHeight;
  const iw = img.width || 1920;
  const ih = img.height || 1080;
  const scale = Math.max(cw / iw, ch / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  const dx = (cw - dw) / 2;
  const dy = (ch - dh) / 2;
  ctx.clearRect(0, 0, cw, ch);
  ctx.drawImage(img, dx, dy, dw, dh);
}

function render() {
  if (useFallback || preloaderHidden === false) {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    return;
  }
  currentFrame += (targetFrame - currentFrame) * 0.12;
  const frame = Math.max(0, Math.min(FRAME_COUNT - 1, Math.round(currentFrame)));
  drawFrame(frame);
  rafId = requestAnimationFrame(render);
}

function hidePreloader() {
  if (preloaderHidden) return;
  preloaderHidden = true;
  preloader.classList.add('is-hidden');
  if (!useFallback) {
    targetFrame = 0;
    currentFrame = 0;
    drawFrame(0);
    render();
  }
}

function forceHidePreloader() {
  if (preloaderHidden) return;
  preloaderHidden = true;
  preloader.classList.add('is-hidden');
  if (!useFallback && frames.length > 0) {
    targetFrame = 0;
    currentFrame = 0;
    drawFrame(0);
    render();
  } else if (useFallback && fallbackVideo) {
    try {
      fallbackVideo.play().catch(() => { });
    } catch (e) { }
  }
}

function generatePlaceholderFrames() {
  for (let i = 0; i < FRAME_COUNT; i++) {
    const off = document.createElement('canvas');
    off.width = 1920;
    off.height = 1080;
    const octx = off.getContext('2d');
    const t = i / (FRAME_COUNT - 1);
    const g = octx.createRadialGradient(960, 540, 200, 960, 540, 980);
    g.addColorStop(0, `rgba(0, ${Math.round(242 - t * 120)}, ${Math.round(254 - t * 80)}, ${0.9 - t * 0.2})`);
    g.addColorStop(0.5, `rgba(${Math.round(t * 60)}, 0, ${Math.round(80 + t * 175)}, ${0.8 - t * 0.1})`);
    g.addColorStop(1, '#050506');
    octx.fillStyle = g;
    octx.fillRect(0, 0, 1920, 1080);

    octx.save();
    octx.translate(960, 540);
    octx.rotate(t * Math.PI * 2.2);
    octx.strokeStyle = `rgba(0, 242, 254, ${0.18 + t * 0.42})`;
    octx.lineWidth = 2;
    octx.beginPath();
    octx.arc(0, 0, 280 + t * 160, 0, Math.PI * 2);
    octx.stroke();
    octx.restore();

    octx.save();
    octx.translate(960 + Math.sin(t * Math.PI * 3) * 160, 540 + Math.cos(t * Math.PI * 2.4) * 110);
    octx.fillStyle = `rgba(181, 123, 255, ${0.32 + t * 0.52})`;
    octx.beginPath();
    octx.arc(0, 0, 12 + t * 14, 0, Math.PI * 2);
    octx.fill();
    octx.restore();

    const img = new Image();
    img.decoding = 'async';
    img.src = off.toDataURL('image/webp', 0.72);
    frames.push(img);
  }
  imagesLoaded = FRAME_COUNT;
  preloaderBar.style.width = '100%';
  preloaderPct.textContent = '100%';
  setTimeout(forceHidePreloader, 400);
}

function loadRealFrames() {
  let tried = 0;
  for (let i = 0; i < FRAME_COUNT; i++) {
    const img = new Image();
    img.decoding = 'async';
    const num = String(i).padStart(4, '0');
    img.src = `./assets/frames/frame_${num}.webp`;
    img.onload = () => {
      tried++;
      if (tried === 1 && imagesLoaded === 0) {
        preloaderBar.style.width = '5%';
        preloaderPct.textContent = '05%';
      }
      imagesLoaded++;
      const pct = Math.min(100, Math.round((imagesLoaded / FRAME_COUNT) * 100));
      preloaderBar.style.width = pct + '%';
      preloaderPct.textContent = pct.toString().padStart(2, '0') + '%';
      if (imagesLoaded >= FRAME_COUNT) {
        setTimeout(hidePreloader, 250);
      }
    };
    img.onerror = () => {
      tried++;
      if (imagesLoaded === 0 && tried >= 12) {
        generatePlaceholderFrames();
      }
    };
    frames.push(img);
  }
  setTimeout(() => {
    if (!preloaderHidden && imagesLoaded === 0) {
      generatePlaceholderFrames();
    }
  }, 1500);
}

function initLenis() {
  if (typeof Lenis === 'undefined') return;
  try {
    const lenis = new Lenis({
      duration: 1.2,
      easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      smoothWheel: true,
      wheelMultiplier: 1,
      touchMultiplier: 1.2,
    });
    function raf(time) {
      lenis.raf(time);
      requestAnimationFrame(raf);
    }
    requestAnimationFrame(raf);
    lenis.on('scroll', ScrollTrigger.update);
    gsap.ticker.add((time) => {
      lenis.raf(time * 1000);
    });
    gsap.ticker.lagSmoothing(0);
    return lenis;
  } catch (e) {
    // ignore
  }
}

function initScroll() {
  const sections = gsap.utils.toArray('.story-section');
  sections.forEach((section) => {
    ScrollTrigger.create({
      trigger: section,
      start: 'top center',
      end: 'bottom center',
      onEnter: () => section.classList.add('is-active'),
      onLeave: () => section.classList.remove('is-active'),
      onEnterBack: () => section.classList.add('is-active'),
      onLeaveBack: () => section.classList.remove('is-active'),
    });
  });

  ScrollTrigger.create({
    trigger: '.frame-stage',
    start: 'top top',
    end: 'bottom bottom',
    scrub: 0.6,
    onUpdate: (self) => {
      const progress = self.progress;
      targetFrame = Math.floor(progress * (FRAME_COUNT - 1));
      const pct = Math.round(progress * 100);
      if (scrollProgress) scrollProgress.style.width = pct + '%';
    },
  });
}

function initCursor() {
  if (!cursorDot || !cursorTrail) return;
  let mouseX = window.innerWidth / 2, mouseY = window.innerHeight / 2;
  let trailX = mouseX, trailY = mouseY;
  document.addEventListener('mousemove', (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
    cursorDot.style.left = mouseX + 'px';
    cursorDot.style.top = mouseY + 'px';
  });
  function loop() {
    trailX += (mouseX - trailX) * 0.12;
    trailY += (mouseY - trailY) * 0.12;
    cursorTrail.style.left = trailX + 'px';
    cursorTrail.style.top = trailY + 'px';
    requestAnimationFrame(loop);
  }
  loop();

  document.querySelectorAll('.btn--magnetic').forEach((btn) => {
    btn.addEventListener('mousemove', (e) => {
      const rect = btn.getBoundingClientRect();
      const x = e.clientX - rect.left - rect.width / 2;
      const y = e.clientY - rect.top - rect.height / 2;
      btn.style.setProperty('--mx', x * 0.25 + 'px');
      btn.style.setProperty('--my', y * 0.25 + 'px');
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.setProperty('--mx', '0px');
      btn.style.setProperty('--my', '0px');
    });
  });
}

function initSound() {
  if (!soundToggle) return;
  let enabled = false;
  let ctxAudio, gain, osc;
  function ensure() {
    if (!ctxAudio) {
      ctxAudio = new (window.AudioContext || window.webkitAudioContext)();
      gain = ctxAudio.createGain();
      gain.gain.value = 0.0001;
      gain.connect(ctxAudio.destination);
    }
  }
  function start() {
    ensure();
    if (osc) return;
    osc = ctxAudio.createOscillator();
    const lfo = ctxAudio.createOscillator();
    const lfoGain = ctxAudio.createGain();
    osc.type = 'sawtooth';
    osc.frequency.value = 110;
    lfo.frequency.value = 0.08;
    lfoGain.gain.value = 12;
    lfo.connect(lfoGain);
    lfoGain.connect(osc.frequency);
    osc.connect(gain);
    osc.start();
    lfo.start();
  }
  soundToggle.addEventListener('click', async () => {
    ensure();
    if (ctxAudio.state === 'suspended') {
      try { await ctxAudio.resume(); } catch (e) { }
    }
    enabled = !enabled;
    soundToggle.classList.toggle('is-active', enabled);
    start();
    if (enabled) {
      gain.gain.exponentialRampToValueAtTime(0.07, ctxAudio.currentTime + 0.8);
    } else {
      gain.gain.exponentialRampToValueAtTime(0.0001, ctxAudio.currentTime + 0.5);
    }
  });
}

function init() {
  setCanvasSize();
  window.addEventListener('resize', setCanvasSize);
  initLenis();
  initScroll();
  initCursor();
  initSound();
  if (exploreBtn) {
    exploreBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const el = document.querySelector('.story-section--shift');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
  generatePlaceholderFrames();
  loadRealFrames();
  setTimeout(forceHidePreloader, 2800);
}

init();
