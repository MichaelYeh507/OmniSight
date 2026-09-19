// Wires the #hud markup in index.html to the clock and the render stats.
// #hud is also the WebXR dom-overlay root, so DOM writes are throttled: per-frame DOM
// updates inside an overlay cost real frame rate on the phone.
import { omni } from './debug.js';

const $ = (id) => document.getElementById(id);

export function setupHud({ clock, manifest, onTopDown }) {
  const els = {
    play: $('btn-play'),
    restart: $('btn-restart'),
    speed: $('sel-speed'),
    scrub: $('scrub'),
    time: $('ro-time'),
    fps: $('ro-fps'),
    points: $('ro-points'),
    scene: $('ro-scene'),
    topdown: $('btn-topdown'),
    caption: $('caption'),
  };

  // XR: a tap on the overlay must not also count as an XR "select" on the scene
  $('hud').addEventListener('beforexrselect', (e) => e.preventDefault());

  els.scene.textContent = manifest.scene;
  if (els.caption) {
    const secs = Number(manifest.processing_seconds);
    els.caption.textContent = Number.isFinite(secs)
      ? `Replayed from a recorded walkthrough. Processed in ${secs < 10 ? secs.toFixed(1) : Math.round(secs)} s.`
      : 'Replayed from a recorded walkthrough.';
  }

  els.scrub.max = String(clock.duration);
  els.scrub.step = String(Math.max(0.01, clock.duration / 1000));
  els.speed.value = String(clock.speed);
  if (els.speed.value !== String(clock.speed)) {
    const opt = document.createElement('option');
    opt.value = opt.textContent = String(clock.speed);
    els.speed.appendChild(opt);
    els.speed.value = opt.value;
  }

  let scrubbing = false;
  els.play.addEventListener('click', () => clock.toggle());
  els.restart.addEventListener('click', () => clock.restart());
  els.speed.addEventListener('change', () => clock.setSpeed(Number(els.speed.value)));
  els.scrub.addEventListener('pointerdown', () => (scrubbing = true));
  els.scrub.addEventListener('pointerup', () => (scrubbing = false));
  els.scrub.addEventListener('pointercancel', () => (scrubbing = false));
  els.scrub.addEventListener('input', () => clock.seek(Number(els.scrub.value)));
  if (els.topdown) {
    if (onTopDown) els.topdown.addEventListener('click', () => els.topdown.classList.toggle('active', onTopDown()));
    else els.topdown.hidden = true;
  }
  window.addEventListener('keydown', (e) => {
    if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.key === ' ') {
      e.preventDefault();
      clock.toggle();
    } else if (e.key === 'r') clock.restart();
    else if (e.key === 'ArrowRight') clock.seek(clock.time + 1);
    else if (e.key === 'ArrowLeft') clock.seek(clock.time - 1);
  });

  const paint = () => {
    els.play.textContent = clock.playing ? 'Pause' : 'Play';
    els.time.textContent = `${clock.time.toFixed(1)} / ${clock.duration.toFixed(1)} s`;
    if (!scrubbing) els.scrub.value = String(clock.time);
    els.fps.textContent = String(omni.fps);
    els.points.textContent = omni.points.toLocaleString();
  };
  clock.onChange(paint);
  paint();

  let lastPaint = 0;
  return {
    els,
    /** Call once per frame; repaints at ~8 Hz. */
    update(nowMs) {
      if (nowMs - lastPaint < 125) return;
      lastPaint = nowMs;
      paint();
    },
  };
}
