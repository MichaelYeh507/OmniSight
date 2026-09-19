// Wires the #hud markup in index.html to the clock and the render stats.
// #hud is also the WebXR dom-overlay root, so DOM writes are throttled: per-frame DOM
// updates inside an overlay cost real frame rate on the phone.
import { omni } from './debug.js';

const $ = (id) => document.getElementById(id);

export function setupHud({ clock, manifest, onTopDown, onCutaway, cutaway = false }) {
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
    xr: $('ro-xr'),
    look: $('sel-look'),
    cutaway: $('btn-cutaway'),
    responders: $('legend-responders'),
  };

  // XR: a tap on the overlay must not also count as an XR "select" on the scene
  $('hud').addEventListener('beforexrselect', (e) => e.preventDefault());

  els.scene.textContent = manifest.scene;
  if (els.caption) {
    const secs = Number(manifest.processing_seconds);
    // honesty captions from the design doc; the two-walkthrough wording applies when manifest.sources has 2+ entries
    const replay = Array.isArray(manifest.sources) && manifest.sources.length > 1
      ? 'Two recorded walkthroughs replayed together.' : 'Replayed from a recorded walkthrough.';
    els.caption.textContent = Number.isFinite(secs)
      ? `${replay} Processed in ${secs < 10 ? secs.toFixed(1) : Math.round(secs)} s.`
      : replay;
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
  if (els.cutaway) {
    if (onCutaway) {
      els.cutaway.classList.toggle('active', cutaway);
      els.cutaway.addEventListener('click', () => els.cutaway.classList.toggle('active', onCutaway()));
    } else els.cutaway.hidden = true;
  }
  if (els.look) {
    els.look.value = omni.look || 'xray';
    els.look.addEventListener('change', () => {
      const url = new URL(location.href);
      url.searchParams.set('look', els.look.value);
      url.searchParams.set('t', clock.time.toFixed(1));
      location.href = url.toString();
    });
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
    if (omni.mode === 'ar') {
      const size = omni.xrFramebuffer;
      els.xr.textContent = `${size ? `${size.width}×${size.height}` : 'XR pending'} · scale ${omni.fbscale} · cap ${omni.budget || 'all'}`;
    }
  };
  clock.onChange(paint);
  paint();

  let lastPaint = 0;
  return {
    els,
    /** Legend rows for the responders, shown only when two or more walkthroughs are replayed together. */
    setResponders(list) {
      if (!els.responders) return;
      els.responders.replaceChildren();
      els.responders.hidden = list.length < 2;
      for (const r of list) {
        const row = document.createElement('div');
        row.className = 'legend-responder';
        const swatch = document.createElement('span');
        swatch.className = 'swatch';
        swatch.style.background = `#${r.color.toString(16).padStart(6, '0')}`;
        row.append(swatch, document.createTextNode(r.label));
        els.responders.append(row);
      }
    },
    /** Call once per frame; repaints at ~8 Hz. */
    update(nowMs) {
      if (nowMs - lastPaint < 125) return;
      lastPaint = nowMs;
      paint();
    },
  };
}
