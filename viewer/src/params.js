// Single place that reads the URL. Everything else imports `params`.
//   ?mode=ar|commander  &scene=<folder>  &t=<s>  &speed=<x>  &budget=<max points>
//   &fbscale=<xr framebuffer scale>  &round=1  &portal=0  &renderer=points|spark  &psize=<size multiplier>
//   &bench=1 holds the complete scene, paused, for point-budget measurements
//   &portaldebug=1 draws the portal in commander mode (headless verification only)
//   &cutaway=0|1  commander only: clip the ceiling and the near wall so the room reads as a doll-house (default on)
//   &look=xray|color|blueprint  x-ray (default): cyan fresh -> dim blue stale; color: recorded RGB; blueprint: dark on white (commander)
//   &cam=follow  commander only: first-person camera on the responder's recorded path (video renders); &fov=<deg> vertical field of view
//   &cam=fixed&campos=x,y,z&camat=x,y,z  commander only: a still virtual camera (recording frame, metres), e.g. in the corridor looking through the wall
//   &cutx=<x> hides points with x below it; &cuty=<y> / &cutz=<z> override the cutaway height and wall depth (commander)
//   &capture=1  clean capture for screen recordings: every HUD panel hidden except the honesty caption (key h toggles it on a keyboard)
//   &wall=z:-1.8 | -x:-0.69 | nx,ny,nz,d  the wall the portal sits on, normal pointing to the outside (default: z:<manifest wall_z>)
//   &portalr=<m>  portal hole radius (default 0.6); &portal=ring for the hard hole with the cyan rim instead of the soft gaze spot
//   &campath=t:x,y,z@ax,ay,az;t:...  scripted camera path for renders (with cam=fixed): eased between keyframes
//   &feed=1  synthetic camera feed layer for renders (recorded colours, all points, big, no HUD); &hud=0 hides the HUD
//   &xray=0|1  start in the camera view (nothing revealed) or in x-ray (default); the HUD X-ray button and key x toggle it
//   &view=camera|xray|natural  the three-way view selector (the radial menu); natural = x-ray in the recorded colours
//   &ui=ar  commander only: phone-screen preview for renders. AR HUD over a transparent page, portal and x-ray toggle live
//   &ax=&ay=&az=&ayaw=  (alignment override in meters / degrees)
const q = new URLSearchParams(location.search);

const num = (key, fallback) => {
  const v = q.get(key);
  if (v === null || v.trim() === '' || !Number.isFinite(Number(v))) return fallback;
  return Number(v);
};

const vec3 = (key) => {
  const parts = (q.get(key) || '').split(',').map(Number);
  return parts.length === 3 && parts.every(Number.isFinite) ? parts : null;
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
  portalStyle: q.get('portal') === 'ring' ? 'ring' : 'soft', // soft (default): feathered gaze spot, no ring; ring: the hard hole with the cyan rim
  portalr: Math.min(3, Math.max(0.1, num('portalr', 0.6))), // portal hole radius in metres (0.6 default; a viewer 1 m from the wall wants 0.4)
  portaldebug: q.get('portaldebug') === '1', // draw the portal in commander mode too (verification only)
  renderer: q.get('renderer') === 'spark' ? 'spark' : 'points',
  psize: num('psize', 1), // point size multiplier
  cutaway: q.has('cutaway') ? q.get('cutaway') === '1' : null, // commander default: on (doll-house view)
  look: ['xray', 'color', 'blueprint'].includes(q.get('look')) ? q.get('look') : 'xray', // colour treatment of the static map
  align: { x: num('ax', NaN), y: num('ay', NaN), z: num('az', NaN), yaw: num('ayaw', NaN) },
  capture: q.get('capture') === '1', // screen-recording mode: only the caption stays on screen
  cam: ['follow', 'fixed'].includes(q.get('cam')) ? q.get('cam') : 'orbit', // follow: the camera rides the responder pose; fixed: campos/camat; both hide the helpers
  campos: vec3('campos'),
  camat: vec3('camat'),
  cutx: num('cutx', NaN),
  cuty: num('cuty', NaN),
  cutz: num('cutz', NaN),
  fov: Math.min(120, Math.max(20, num('fov', 60))), // vertical fov; 56 matches the iPhone 14 Pro colour camera at 4:3 (fx 1348 / 1920 px), 43.6 its 16:9 crop
  wall: q.get('wall') || null, // parsed with the manifest by scene-data parseWall
  outlines: q.get('outlines') !== '0', // hot-red object outlines from <scene>/outlines.json when the file exists
  outlinelabels: q.get('outlinelabels') !== '0', // their name tags
  map: q.get('map') !== '0', // the team map (top-down minimap) in the HUD
  mapsize: Math.min(2000, Math.max(0, num('mapsize', 0))), // CSS px; 0 = the default; a big value for a minimap showcase render
  xray: q.get('xray') !== '0',
  view: ['camera', 'xray', 'natural'].includes(q.get('view')) ? q.get('view') : q.get('xray') === '0' ? 'camera' : 'xray', // camera: nothing revealed; xray: cyan map; natural: recorded colours
  ui: q.get('ui') === 'ar' ? 'ar' : null,
  campath: q.get('campath') || null, // scripted camera for renders: "t:x,y,z@ax,ay,az;..." (scene-data parseCamPath), with cam=fixed
  feed: q.get('feed') === '1', // synthetic camera feed for renders: recorded colours, every point at every time, big points, no HUD, no overlays
  hud: q.get('hud') !== '0', // hud=0 hides the whole HUD (renders of a bare layer)
});

// Scene files live under public/scenes/<scene>/ and are served under the Vite base.
export const sceneUrl = (file) => `${import.meta.env.BASE_URL}scenes/${params.scene}/${file}`;
