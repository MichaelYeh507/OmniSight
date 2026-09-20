// Wires the #hud markup in index.html to the clock and the render stats.
// #hud is also the WebXR dom-overlay root, so DOM writes are throttled: per-frame DOM
// updates inside an overlay cost real frame rate on the phone.
import { omni } from './debug.js';
import { setupWheel } from './wheel.js';

const $ = (id) => document.getElementById(id);

export function setupHud({ clock, manifest, renderer = 'points', onTopDown, onCutaway, cutaway = false, onXray = null, onView = null }) {
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
    xray: $('btn-xray'),
    mode: $('ro-mode'),
    tape: $('tape-canvas'),
    heading: $('ro-heading'),
    progressFill: $('progress-fill'),
    progressTime: $('progress-time'),
  };
  const tape = els.tape ? els.tape.getContext('2d') : null;
  let headingDeg = 0; // degrees clockwise from the recording's forward (-Z); set by main from the active camera
  let bearings = []; // [{ deg, kind: 'team' | 'person' }] marks on the tape, set by main
  const paintTape = () => {
    if (!tape) return;
    const W = els.tape.width;
    const H = els.tape.height;
    const span = 90; // degrees visible across the tape
    const pxPerDeg = W / span;
    tape.clearRect(0, 0, W, H);
    tape.strokeStyle = 'rgba(238, 243, 246, 0.55)';
    tape.fillStyle = 'rgba(238, 243, 246, 0.8)';
    tape.font = '600 18px system-ui, sans-serif';
    tape.textAlign = 'center';
    tape.textBaseline = 'top';
    tape.lineWidth = 2;
    const first = Math.floor((headingDeg - span / 2) / 10) * 10;
    for (let d = first; d <= headingDeg + span / 2; d += 10) {
      const x = W / 2 + (d - headingDeg) * pxPerDeg;
      if (x < 0 || x > W) continue;
      const major = d % 30 === 0;
      tape.beginPath();
      tape.moveTo(x, H);
      tape.lineTo(x, H - (major ? 18 : 9));
      tape.stroke();
      if (major) tape.fillText(String(((d % 360) + 360) % 360).padStart(3, '0'), x, 0);
    }
    // who is where: a cyan square per teammate, an orange diamond for the person, at their bearings
    for (const b of bearings) {
      let rel = ((b.deg - headingDeg) % 360 + 540) % 360 - 180;
      if (Math.abs(rel) > span / 2) continue;
      const x = W / 2 + rel * pxPerDeg;
      tape.fillStyle = b.kind === 'person' ? '#ff8a4a' : '#6fe3ff';
      tape.beginPath();
      if (b.kind === 'person') { tape.moveTo(x, H - 30); tape.lineTo(x + 7, H - 23); tape.lineTo(x, H - 16); tape.lineTo(x - 7, H - 23); }
      else tape.rect(x - 5, H - 29, 10, 10);
      tape.closePath();
      tape.fill();
    }
    // centre mark
    tape.fillStyle = 'rgba(238, 243, 246, 0.9)';
    tape.beginPath();
    tape.moveTo(W / 2 - 6, H);
    tape.lineTo(W / 2 + 6, H);
    tape.lineTo(W / 2, H - 10);
    tape.closePath();
    tape.fill();
    if (els.heading) els.heading.textContent = `${Math.round(((headingDeg % 360) + 360) % 360)}°`;
  };

  // XR: a tap on the overlay must not also count as an XR "select" on the scene
  $('hud').addEventListener('beforexrselect', (e) => e.preventDefault());

  els.scene.textContent = manifest.scene;
  if (els.caption) {
    const secs = Number(manifest.processing_seconds);
    // honesty captions from the design doc: a replay, not live; point-based rendering unless the Spark splat path is on;
    // the two-walkthrough wording applies when manifest.sources has 2+ entries
    const replay = Array.isArray(manifest.sources) && manifest.sources.length > 1
      ? 'Two recorded walkthroughs replayed together' : 'Replayed from a recorded walkthrough';
    const method = renderer === 'spark' ? 'Gaussian splat rendering' : 'point-based rendering';
    const processed = Number.isFinite(secs) ? ` · processed in ${secs < 10 ? secs.toFixed(1) : Math.round(secs)} s` : '';
    els.caption.textContent = `${replay} · ${method}${processed}`;
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
  if (els.xray) {
    if (onXray) els.xray.addEventListener('click', () => onXray());
    else els.xray.hidden = true;
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
    else if (e.key === 'h') { // clean capture toggle for screen recordings (same as ?capture=1)
      omni.capture = document.body.dataset.capture !== '1';
      document.body.dataset.capture = omni.capture ? '1' : '';
    }
    else if (e.key === 'x' && onXray) onXray();
    else if (e.key === 'm' && wheel) wheel.toggle();
    else if (['1', '2', '3'].includes(e.key) && wheel) wheel.select(['camera', 'xray', 'natural'][Number(e.key) - 1]);
    else if (e.key === 'Escape' && wheel) wheel.close();
    else if (e.key === 'ArrowRight') clock.seek(clock.time + 1);
    else if (e.key === 'ArrowLeft') clock.seek(clock.time - 1);
  });

  const VIEW_LABEL = { camera: 'Camera', xray: 'X-ray', natural: 'Natural' };
  const paintMode = () => {
    if (!els.mode) return;
    const text = omni.aligning ? 'Aligning' : VIEW_LABEL[omni.view] || (omni.xray && omni.xray.on ? 'X-ray' : 'Camera');
    if (els.mode.textContent !== text) els.mode.textContent = text;
    document.body.dataset.aligning = omni.aligning ? '1' : '';
  };
  // the radial view selector (Camera / X-ray / Natural): the mode word or key m opens it, 1/2/3 pick directly
  const wheelCanvas = $('wheel-canvas');
  const wheel = wheelCanvas && onView ? setupWheel({ canvas: wheelCanvas, onSelect: onView, size: window.innerWidth < 480 ? 180 : 220 }) : null;
  if (els.mode && wheel) {
    els.mode.addEventListener('click', () => wheel.toggle());
    els.mode.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); wheel.toggle(); } });
  }
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
    if (els.progressFill) els.progressFill.style.width = `${clock.duration > 0 ? (100 * clock.time / clock.duration).toFixed(2) : 0}%`;
    if (els.progressTime) els.progressTime.textContent = `${clock.time.toFixed(1)} s`;
    paintTape();
    paintMode();
  };
  clock.onChange(paint);
  paint();

  let lastPaint = 0;
  return {
    els,
    wheel,
    /** The three-way view changed elsewhere (URL, script, wheel): keep the wheel's mark and the mode word in step. */
    setView(view) {
      if (wheel) wheel.setView(view);
      paintMode();
    },
    /** X-ray button state; the body attribute lets CSS hide the data-age legend while nothing is revealed. */
    setXray(on) {
      if (els.xray) {
        els.xray.classList.toggle('active', !!on);
        els.xray.setAttribute('aria-pressed', String(!!on));
      }
      paintMode();
    },
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
    /** Heading of the viewer's camera in degrees clockwise from the recording's forward; painted with the next repaint. */
    setHeading(deg, marks = []) {
      headingDeg = Number.isFinite(deg) ? deg : 0;
      bearings = marks;
    },
    /** Call once per frame; repaints at ~8 Hz. */
    update(nowMs) {
      if (wheel) wheel.update(nowMs);
      if (nowMs - lastPaint < 125) return;
      lastPaint = nowMs;
      paint();
    },
  };
}
