// Radial view selector: a translucent ring with three sectors (Camera, X-ray, Natural), the current one marked by a
// white arc, a small label under the ring. Opens on the mode word, key `m`, or `omni.wheel.open()`; a tap on a sector
// (or keys 1/2/3, or `select(view)`) picks it and the ring closes. For renders, `showAt(view, progress)` drives the
// open-highlight-close animation frame-exactly on the replay clock. Drawn on a 2D canvas only while animating.
export const WHEEL_VIEWS = [
  { id: 'camera', label: 'Camera' },
  { id: 'xray', label: 'X-ray' },
  { id: 'natural', label: 'Natural' },
];
export const WHEEL_OPEN_MS = 220;

export function setupWheel({ canvas, caption, onSelect, size = 220 }) {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  const ctx = canvas.getContext('2d');
  const C = canvas.width / 2;
  const R = C - 4 * dpr;
  const state = { open: 0, target: 0, view: 'xray', hover: null, lastMs: null, scripted: null };
  const sectorOf = (id) => WHEEL_VIEWS.findIndex((v) => v.id === id);
  // sector angles: three equal thirds, starting at the top
  const angles = (i) => { const a0 = -Math.PI / 2 + i * (2 * Math.PI / 3); return [a0, a0 + 2 * Math.PI / 3]; };

  const paint = () => {
    const p = state.scripted ? state.scripted.progress : state.open;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (p <= 0.001) { canvas.style.opacity = '0'; return; }
    canvas.style.opacity = String(Math.min(1, p * 1.4));
    const scale = 0.85 + 0.15 * p;
    ctx.save();
    ctx.translate(C, C);
    ctx.scale(scale, scale);
    ctx.translate(-C, -C);
    // ring body
    ctx.lineWidth = 34 * dpr;
    ctx.strokeStyle = 'rgba(34, 40, 46, 0.62)';
    ctx.beginPath();
    ctx.arc(C, C, R - 20 * dpr, 0, Math.PI * 2);
    ctx.stroke();
    // sector dividers
    ctx.strokeStyle = 'rgba(238, 243, 246, 0.35)';
    ctx.lineWidth = 1 * dpr;
    for (let i = 0; i < 3; i++) {
      const [a0] = angles(i);
      ctx.beginPath();
      ctx.moveTo(C + Math.cos(a0) * (R - 37 * dpr), C + Math.sin(a0) * (R - 37 * dpr));
      ctx.lineTo(C + Math.cos(a0) * (R - 3 * dpr), C + Math.sin(a0) * (R - 3 * dpr));
      ctx.stroke();
    }
    // selection arc: white, on the sector of the current (or hovered) view
    const sel = sectorOf(state.hover || state.view);
    if (sel >= 0) {
      const [a0, a1] = angles(sel);
      ctx.strokeStyle = 'rgba(238, 243, 246, 0.95)';
      ctx.lineWidth = 3 * dpr;
      ctx.beginPath();
      ctx.arc(C, C, R - 1.5 * dpr, a0 + 0.04, a1 - 0.04);
      ctx.stroke();
    }
    // labels
    ctx.fillStyle = 'rgba(238, 243, 246, 0.92)';
    ctx.font = `500 ${11 * dpr}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    WHEEL_VIEWS.forEach((v, i) => {
      const [a0, a1] = angles(i);
      const a = (a0 + a1) / 2;
      const r = R - 20 * dpr;
      ctx.fillStyle = i === sel ? '#ffffff' : 'rgba(238, 243, 246, 0.8)';
      ctx.fillText(v.label, C + Math.cos(a) * r, C + Math.sin(a) * r);
    });
    // centre: the current view's id
    ctx.fillStyle = 'rgba(238, 243, 246, 0.6)';
    ctx.font = `400 ${9.5 * dpr}px system-ui, sans-serif`;
    ctx.fillText('view', C, C - 7 * dpr);
    ctx.fillStyle = '#ffffff';
    ctx.font = `500 ${12 * dpr}px system-ui, sans-serif`;
    ctx.fillText(WHEEL_VIEWS[sectorOf(state.hover || state.view)]?.label || '', C, C + 8 * dpr);
    ctx.restore();
  };

  const pick = (x, y) => { // canvas-local CSS px -> sector id, or null near the centre
    const dx = x - size / 2;
    const dy = y - size / 2;
    if (Math.hypot(dx, dy) < size * 0.12) return null;
    let a = Math.atan2(dy, dx) + Math.PI / 2; // 0 at the top
    if (a < 0) a += 2 * Math.PI;
    return WHEEL_VIEWS[Math.floor(a / (2 * Math.PI / 3)) % 3].id;
  };
  canvas.addEventListener('pointermove', (e) => {
    if (state.target < 1) return;
    const r = canvas.getBoundingClientRect();
    state.hover = pick(e.clientX - r.left, e.clientY - r.top);
    paint();
  });
  canvas.addEventListener('pointerleave', () => { state.hover = null; paint(); });
  canvas.addEventListener('click', (e) => {
    if (state.target < 1) return;
    const r = canvas.getBoundingClientRect();
    const id = pick(e.clientX - r.left, e.clientY - r.top);
    if (id) api.select(id);
    else api.close();
  });

  const api = {
    state,
    get isOpen() { return state.target === 1; },
    open() { state.target = 1; state.hover = null; canvas.style.pointerEvents = 'auto'; paint(); },
    close() { state.target = 0; state.hover = null; canvas.style.pointerEvents = 'none'; },
    toggle() { state.target === 1 ? api.close() : api.open(); },
    /** Pick a view: highlights it, closes the ring, tells the app. */
    select(id) {
      if (!WHEEL_VIEWS.some((v) => v.id === id)) return;
      state.view = id;
      state.hover = null;
      api.close();
      if (caption) caption.textContent = WHEEL_VIEWS[sectorOf(id)].label;
      onSelect?.(id);
    },
    /** The current view without opening anything (the app's state changed elsewhere). */
    setView(id) { state.view = id; if (caption) caption.textContent = WHEEL_VIEWS[sectorOf(id)]?.label || ''; },
    /**
     * Scripted animation for renders, on the replay clock: `progress` 0..1 = ring opening, hover sweeping to `hover`,
     * then closing. null clears the script.
     */
    showAt(spec) {
      state.scripted = spec ? { progress: spec.progress } : null;
      if (spec) state.hover = spec.hover || null;
      else state.hover = null;
      paint();
    },
    /** Once per frame: eases the open state; repaints only while moving. */
    update(nowMs) {
      if (state.scripted) return;
      if (state.lastMs === null) state.lastMs = nowMs;
      const dt = Math.min(100, nowMs - state.lastMs);
      state.lastMs = nowMs;
      const before = state.open;
      const step = dt / WHEEL_OPEN_MS;
      state.open = state.target > state.open ? Math.min(1, state.open + step) : Math.max(0, state.open - step);
      if (state.open !== before) paint();
    },
  };
  canvas.style.opacity = '0';
  canvas.style.pointerEvents = 'none';
  return api;
}
