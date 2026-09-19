// Single place that reads the URL. Everything else imports `params`.
//   ?mode=ar|commander  &scene=<folder>  &t=<s>  &speed=<x>  &budget=<max points>
//   &fbscale=<xr framebuffer scale>  &round=1  &portal=0  &renderer=points|spark
//   &ax=&ay=&az=&ayaw=  (alignment override in meters / degrees)
const q = new URLSearchParams(location.search);

const num = (key, fallback) => {
  const v = q.get(key);
  if (v === null || v === '' || Number.isNaN(Number(v))) return fallback;
  return Number(v);
};

export const params = Object.freeze({
  mode: q.get('mode') === 'ar' ? 'ar' : 'commander',
  scene: (q.get('scene') || 'box').replace(/[^a-z0-9_]/gi, ''),
  t: num('t', 0),
  speed: num('speed', 1),
  budget: num('budget', 0), // 0 = unlimited; caps the draw range for fps tests
  fbscale: num('fbscale', 1), // WebXR framebuffer scale factor
  round: q.get('round') === '1',
  portal: q.get('portal') !== '0',
  renderer: q.get('renderer') === 'spark' ? 'spark' : 'points',
  align: { x: num('ax', NaN), y: num('ay', NaN), z: num('az', NaN), yaw: num('ayaw', NaN) },
});

// Scene files live under public/scenes/<scene>/ and are served under the Vite base.
export const sceneUrl = (file) => `${import.meta.env.BASE_URL}scenes/${params.scene}/${file}`;
