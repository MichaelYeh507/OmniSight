// window.__omni is the debug surface for humans (chrome://inspect) and smoke tests.
export const omni = (window.__omni = {
  mode: '',
  scene: '',
  clock: 0,
  points: 0,
  fps: 0,
  resets: 0,
  xrFramebuffer: null,
  xrPresenting: false,
  tracking: false,
  benchmark: null,
  errors: [],
});

export function showError(err) {
  const msg = err && err.message ? err.message : String(err);
  omni.errors.push(msg);
  const el = document.getElementById('error-banner');
  if (el) {
    el.textContent = msg;
    el.hidden = false;
  }
  const overlay = document.getElementById('xr-error');
  if (overlay) { overlay.textContent = msg; overlay.hidden = false; }
  if (!omni.xrPresenting) document.getElementById('pre')?.classList.remove('hidden');
  console.error('[omni]', err);
}

window.addEventListener('error', (e) => showError(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => showError(e.reason));

// Rolling fps, updated twice a second.
let frames = 0;
let last = null;
export function resetFps() { frames = 0; last = null; omni.fps = 0; }
export function tickFps(now) {
  if (last === null) { last = now; return; }
  frames += 1;
  if (now - last >= 500) {
    omni.fps = Math.round((frames * 1000) / (now - last));
    frames = 0;
    last = now;
  }
}
