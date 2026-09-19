// Single place that reads the URL. Everything else imports `params`.
//   ?mode=ar|commander  &scene=<folder>  &t=<s>  &speed=<x>  &budget=<max points>
//   &fbscale=<xr framebuffer scale>  &round=1  &portal=0  &renderer=points|spark  &psize=<size multiplier>
//   &bench=1 holds the complete scene, paused, for point-budget measurements
//   &portaldebug=1 draws the portal in commander mode (headless verification only)
//   &cutaway=0|1  commander only: clip the ceiling and the near wall so the room reads as a doll-house (default on)
//   &look=xray|color|blueprint  x-ray (default): cyan fresh -> dim blue stale; color: recorded RGB; blueprint: dark on white (commander)
//   &capture=1  clean capture for screen recordings: every HUD panel hidden except the honesty caption (key h toggles it on a keyboard)
//   &ax=&ay=&az=&ayaw=  (alignment override in meters / degrees)
const q = new URLSearchParams(location.search);

const num = (key, fallback) => {
  const v = q.get(key);
  if (v === null || v.trim() === '' || !Number.isFinite(Number(v))) return fallback;
  return Number(v);
};

export const params = Object.freeze({
  mode: q.get('mode') === 'ar' ? 'ar' : 'commander',
  scene: (q.get('scene') || 'box').replace(/[^a-z0-9_]/gi, ''),
  t: num('t', 0),
  speed: num('speed', 1),
  budget: Math.max(0, Math.floor(num('budget', 0))), // 0 = unlimited; caps the draw range for fps tests
  bench: q.get('bench') === '1', // hold the complete scene for reproducible fps tests
  fbscale: Math.min(2, Math.max(0.1, num('fbscale', 1))), // WebXR framebuffer scale factor
  round: q.get('round') === '1',
  portal: q.get('portal') !== '0',
  portaldebug: q.get('portaldebug') === '1', // draw the portal in commander mode too (verification only)
  renderer: q.get('renderer') === 'spark' ? 'spark' : 'points',
  psize: num('psize', 1), // point size multiplier
  cutaway: q.has('cutaway') ? q.get('cutaway') === '1' : null, // commander default: on (doll-house view)
  look: ['xray', 'color', 'blueprint'].includes(q.get('look')) ? q.get('look') : 'xray', // colour treatment of the static map
  align: { x: num('ax', NaN), y: num('ay', NaN), z: num('az', NaN), yaw: num('ayaw', NaN) },
  capture: q.get('capture') === '1', // screen-recording mode: only the caption stays on screen
});

// Scene files live under public/scenes/<scene>/ and are served under the Vite base.
export const sceneUrl = (file) => `${import.meta.env.BASE_URL}scenes/${params.scene}/${file}`;
