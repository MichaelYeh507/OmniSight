// Team map: a small north-up (jig-forward-up) top-down map in the HUD. It shows what the map has
// scanned so far (cells coloured by data age, the same 5 s / 30 s ramp as the points), the wall the
// portal sits on, every responder (the teammates who recorded) with heading and label, the person
// ghost, and the viewer ("you"). Drawn on a 2D canvas at most 8 times per replay second: DOM work
// inside the XR overlay costs frame rate, and replay-time throttling keeps renders deterministic.
import { STALE_START, STALE_END } from './points.js';
import { planeDistance } from './scene-data.js';

const FRESH = [0x9e, 0xf4, 0xff];
const STALE = [0x24, 0x47, 0x6b];
const PERSON = '#ff8a4a';
const YOU = '#ffffff';
const MAX_CELLS = 140;
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * Occupancy grid of the static map between floor + 0.25 m and floor + 1.9 m (walls and furniture, not the
 * floor or ceiling): per cell the earliest tSeen and the point count. Pure, so tests can cover it.
 */
export function buildOccupancy(staticData, floorY, { maxCells = MAX_CELLS, pad = 0.6 } = {}) {
  const { positions, tSeen, count, bounds } = staticData;
  const minX = bounds.min[0] - pad, maxX = bounds.max[0] + pad;
  const minZ = bounds.min[2] - pad, maxZ = bounds.max[2] + pad;
  const cell = Math.max(0.06, Math.max(maxX - minX, maxZ - minZ) / maxCells);
  const nx = Math.ceil((maxX - minX) / cell), nz = Math.ceil((maxZ - minZ) / cell);
  const first = new Float32Array(nx * nz).fill(Infinity);
  const hits = new Uint16Array(nx * nz);
  const lo = (Number.isFinite(floorY) ? floorY : bounds.min[1]) + 0.25;
  const hi = lo + 1.65;
  for (let i = 0; i < count; i++) {
    const y = positions[3 * i + 1];
    if (y < lo || y > hi) continue;
    const k = Math.floor((positions[3 * i + 2] - minZ) / cell) * nx + Math.floor((positions[3 * i] - minX) / cell);
    if (k < 0 || k >= nx * nz) continue;
    if (tSeen[i] < first[k]) first[k] = tSeen[i];
    if (hits[k] < 65535) hits[k] += 1;
  }
  return { nx, nz, cell, minX, minZ, first, hits, width: nx * cell, depth: nz * cell };
}

export function setupMinimap({ canvas, staticData, floorY, wall = null, responders = [], size = 150 }) {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  const ctx = canvas.getContext('2d');
  const grid = buildOccupancy(staticData, floorY);
  const off = document.createElement('canvas');
  off.width = grid.nx;
  off.height = grid.nz;
  const offCtx = off.getContext('2d');
  const image = offCtx.createImageData(grid.nx, grid.nz);
  // fit the grid into the canvas, jig forward (-Z) up: canvas x = world x, canvas y = world z
  const inset = 8 * dpr;
  const scale = Math.min((canvas.width - 2 * inset) / grid.width, (canvas.height - 2 * inset) / grid.depth);
  const ox = (canvas.width - grid.width * scale) / 2, oy = (canvas.height - grid.depth * scale) / 2;
  const toCanvas = (x, z) => [ox + (x - grid.minX) * scale, oy + (z - grid.minZ) * scale];
  const colours = responders.map((r) => `#${(r.color ?? 0x4dd9ff).toString(16).padStart(6, '0')}`);
  let lastT = -Infinity;
  let lastKey = '';

  const paintCells = (t) => {
    const d = image.data;
    for (let k = 0; k < grid.nx * grid.nz; k++) {
      const p = 4 * k;
      const seen = grid.first[k];
      if (!(seen <= t)) { d[p + 3] = 0; continue; }
      const s = smoothstep(STALE_START, STALE_END, t - seen);
      d[p] = FRESH[0] + (STALE[0] - FRESH[0]) * s;
      d[p + 1] = FRESH[1] + (STALE[1] - FRESH[1]) * s;
      d[p + 2] = FRESH[2] + (STALE[2] - FRESH[2]) * s;
      d[p + 3] = Math.round(255 * Math.min(1, 0.35 + grid.hits[k] / 8));
    }
    offCtx.putImageData(image, 0, 0);
  };

  const dot = (x, z, colour, r, heading = null) => {
    const [cx, cy] = toCanvas(x, z);
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    if (heading !== null) { // heading: world yaw where 0 looks along -Z (up on the map)
      ctx.strokeStyle = colour;
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.sin(heading) * r * 2.6, cy - Math.cos(heading) * r * 2.6);
      ctx.stroke();
    }
    return [cx, cy];
  };

  return {
    grid,
    /**
     * state: { responders: [{ source, position, heading }], ghost: { centroid, alpha } | null,
     *          viewer: { position: [x,y,z], heading } | null, reveal }
     */
    update(t, state) {
      const key = `${state.reveal > 0}|${state.viewer ? state.viewer.position.map((v) => v.toFixed(2)).join() + state.viewer.heading.toFixed(2) : ''}`;
      if (Math.abs(t - lastT) < 0.125 && key === lastKey) return;
      lastT = t;
      lastKey = key;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      // round map with a tick ring, like a compass rose; everything below is clipped to the disc
      const R = canvas.width / 2 - 2 * dpr;
      const C = canvas.width / 2;
      ctx.save();
      ctx.beginPath();
      ctx.arc(C, C, R, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = 'rgba(4, 10, 16, 0.5)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      paintCells(t);
      ctx.imageSmoothingEnabled = true;
      ctx.globalAlpha = state.reveal > 0 ? 1 : 0.45; // the camera view still knows the map, dimmed
      ctx.drawImage(off, ox, oy, grid.width * scale, grid.depth * scale);
      ctx.globalAlpha = 1;
      if (wall) { // the wall plane clipped to the map: n·p = d with n in XZ
        const [nxw, , nzw] = wall.normal;
        if (Math.hypot(nxw, nzw) > 1e-3) {
          const corners = [[grid.minX, grid.minZ], [grid.minX + grid.width, grid.minZ], [grid.minX + grid.width, grid.minZ + grid.depth], [grid.minX, grid.minZ + grid.depth]];
          const pts = [];
          for (let i = 0; i < 4; i++) {
            const a = corners[i], b = corners[(i + 1) % 4];
            const da = planeDistance(wall, [a[0], 0, a[1]]), db = planeDistance(wall, [b[0], 0, b[1]]);
            if ((da <= 0) !== (db <= 0)) { const s = da / (da - db); pts.push([a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s]); }
          }
          if (pts.length >= 2) {
            ctx.strokeStyle = 'rgba(77, 217, 255, 0.85)';
            ctx.lineWidth = 1.5 * dpr;
            ctx.setLineDash([4 * dpr, 3 * dpr]);
            ctx.beginPath();
            ctx.moveTo(...toCanvas(pts[0][0], pts[0][1]));
            ctx.lineTo(...toCanvas(pts[1][0], pts[1][1]));
            ctx.stroke();
            ctx.setLineDash([]);
          }
        }
      }
      ctx.font = `600 ${Math.max(8.5, size / 17) * dpr}px system-ui, sans-serif`; // scales with a showcase-sized map
      ctx.textBaseline = 'middle';
      for (const r of state.responders || []) {
        const colour = colours[r.source] || colours[0] || '#4dd9ff';
        const [cx, cy] = toCanvas(r.position[0], r.position[2]);
        ctx.fillStyle = colour; // a cyan square, like a friendly on the reference HUD
        const m = Math.max(1, size / 150) * dpr; ctx.fillRect(cx - 3.5 * m, cy - 3.5 * m, 7 * m, 7 * m);
        if (r.heading !== null && r.heading !== undefined) {
          ctx.strokeStyle = colour;
          ctx.lineWidth = 1.5 * dpr;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(cx + Math.sin(r.heading) * 9 * m, cy - Math.cos(r.heading) * 9 * m);
          ctx.stroke();
        }
        ctx.fillText(r.label || `R${r.source + 1}`, cx + 6 * dpr, cy - 7 * dpr);
      }
      if (state.ghost && state.ghost.visible) { // an orange diamond for the person
        ctx.globalAlpha = Math.max(0.25, state.ghost.alpha);
        const [cx, cy] = toCanvas(state.ghost.centroid[0], state.ghost.centroid[2]);
        const r = 5 * Math.max(1, size / 150) * dpr;
        ctx.fillStyle = PERSON;
        ctx.beginPath();
        ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy); ctx.lineTo(cx, cy + r); ctx.lineTo(cx - r, cy);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      if (state.viewer) {
        const [cx, cy] = toCanvas(state.viewer.position[0], state.viewer.position[2]);
        const h = state.viewer.heading || 0;
        ctx.fillStyle = YOU;
        ctx.beginPath();
        const y = Math.max(1, size / 150) * dpr;
        ctx.moveTo(cx + Math.sin(h) * 7 * y, cy - Math.cos(h) * 7 * y);
        ctx.lineTo(cx + Math.sin(h + 2.5) * 6 * y, cy - Math.cos(h + 2.5) * 6 * y);
        ctx.lineTo(cx + Math.sin(h - 2.5) * 6 * y, cy - Math.cos(h - 2.5) * 6 * y);
        ctx.closePath();
        ctx.fill();
      }
      if (state.viewer) { // the viewer's field of view as a translucent wedge
        const [cx, cy] = toCanvas(state.viewer.position[0], state.viewer.position[2]);
        const h = state.viewer.heading || 0;
        const half = ((state.viewer.fov || 60) / 2) * Math.PI / 180;
        ctx.fillStyle = 'rgba(238, 243, 246, 0.14)';
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, R * 0.9, h - half - Math.PI / 2, h + half - Math.PI / 2);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
      // tick ring: every 30 degrees, longer at 90
      ctx.strokeStyle = 'rgba(238, 243, 246, 0.55)';
      ctx.lineWidth = 1 * dpr;
      ctx.beginPath();
      ctx.arc(C, C, R, 0, Math.PI * 2);
      ctx.stroke();
      for (let a = 0; a < 360; a += 30) {
        const len = a % 90 === 0 ? 6 * dpr : 3 * dpr;
        const rad = (a - 90) * Math.PI / 180;
        ctx.beginPath();
        ctx.moveTo(C + Math.cos(rad) * R, C + Math.sin(rad) * R);
        ctx.lineTo(C + Math.cos(rad) * (R - len), C + Math.sin(rad) * (R - len));
        ctx.stroke();
      }
      // scale bar: 1 m
      ctx.strokeStyle = 'rgba(238, 243, 246, 0.7)';
      ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath();
      ctx.moveTo(C - scale / 2, canvas.height - 5 * dpr);
      ctx.lineTo(C + scale / 2, canvas.height - 5 * dpr);
      ctx.stroke();
    },
  };
}
