// Commander mode: orbit the replay on an iPad or laptop. No portal, no camera feed.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { camPathAt } from '../scene-data.js';
import { omni } from '../debug.js';

const THEMES = {
  dark: { background: 0x0b0f14, grid: [0x3a5068, 0x1c2836], wall: 0x5c7590, alignmentBrightness: 0.45 },
  blueprint: { background: 0xf4f6f8, grid: [0xb4c0cc, 0xdfe5eb], wall: 0x6c7a8a, alignmentBrightness: 1 },
};

export const CUTAWAY_HEIGHT = 0.9; // metres above the jig camera height: roughly head height, removes ceilings

export function setupCommander({ renderer, scene, camera, sceneRoot, data, alignmentCloud, staticCloud, look = 'xray', cutaway = true, cam = 'orbit', campos = null, camat = null, campath = null, cut: clipParams = {}, ui = null }) {
  const follow = cam === 'follow';
  const fixed = cam === 'fixed' && (!!campos || !!campath);
  const preview = ui === 'ar'; // phone-screen preview for renders: transparent page (footage goes behind it), no helpers
  const clean = follow || fixed || preview; // video viewpoints: no grid, axes or wall outline
  const theme = look === 'blueprint' ? THEMES.blueprint : THEMES.dark;
  scene.background = preview ? null : new THREE.Color(theme.background);
  renderer.setClearAlpha(preview ? 0 : 1);

  const floorY = data.floorY ?? data.static.bounds.min[1];
  const { min, max } = data.static.bounds;
  const cx = (min[0] + max[0]) / 2;
  const cz = (min[2] + max[2]) / 2;

  // floor grid at floor_y, 0.5 m cells
  const span = Math.ceil(Math.max(max[0] - min[0], Math.abs(min[2]) + 1, 6) / 2) * 2 + 4;
  const grid = new THREE.GridHelper(span, span * 2, theme.grid[0], theme.grid[1]);
  grid.position.set(cx, floorY - 0.005, cz);
  grid.visible = !clean;
  sceneRoot.add(grid);

  // the jig (origin) and its facing direction
  const jig = new THREE.AxesHelper(0.4);
  jig.visible = !clean;
  sceneRoot.add(jig);

  // faint outline of the wall plane the alignment happens against
  if (data.wallZ !== null) {
    const yTop = Math.max(max[1], floorY + 2.4);
    const pts = [
      new THREE.Vector3(min[0], floorY, data.wallZ),
      new THREE.Vector3(max[0], floorY, data.wallZ),
      new THREE.Vector3(max[0], yTop, data.wallZ),
      new THREE.Vector3(min[0], yTop, data.wallZ),
    ];
    const wall = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: theme.wall, transparent: true, opacity: 0.6 }),
    );
    wall.visible = !clean;
    sceneRoot.add(wall);
  }

  // the recorded outside of the wall is context here: dimmed on dark looks, removed on the
  // blueprint look so the room reads as an architectural cutaway
  if (alignmentCloud) alignmentCloud.uniforms.uBrightness.value = theme.alignmentBrightness;
  const clip = { x: clipParams.x, y: clipParams.y, z: clipParams.z }; // URL overrides: cutx hides x below, cuty/cutz replace the defaults
  let cut = false;
  const setCutaway = (on) => {
    cut = !!on;
    // orbit view: doll-house defaults (ceiling and near wall); a fixed camera clips only the axes given in the URL
    const defaultY = fixed ? 1e9 : CUTAWAY_HEIGHT;
    const defaultZ = fixed || data.wallZ === null ? 1e9 : data.wallZ - 0.08;
    if (staticCloud) staticCloud.setCutaway(cut ? { y: Number.isFinite(clip.y) ? clip.y : defaultY, z: Number.isFinite(clip.z) ? clip.z : defaultZ, xmin: Number.isFinite(clip.x) ? clip.x : -1e9 } : null);
    if (alignmentCloud) alignmentCloud.visible = !cut && look !== 'blueprint';
    return cut;
  };
  // first person sits inside the room: never clip the ceiling away; a fixed camera clips only when asked to
  setCutaway(follow ? false : fixed ? [clip.x, clip.y, clip.z].some(Number.isFinite) : cutaway);

  // stand behind the jig looking into the room
  const target = new THREE.Vector3(cx, floorY + 1.0, (data.wallZ ?? cz) - 1.2);
  camera.position.set(0.6, floorY + 2.6, 3.2);
  if (fixed) {
    const start = campath ? camPathAt(campath, -Infinity) : null;
    camera.position.fromArray(start ? start.pos : campos);
    if (start) target.fromArray(start.at);
    else if (camat) target.fromArray(camat);
  }
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(target);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.minDistance = 0.3;
  controls.maxDistance = 40;
  controls.enabled = !(follow || fixed);
  controls.update();

  let topDown = false;
  let saved = null;
  const toggleTopDown = () => {
    topDown = !topDown;
    if (topDown) {
      saved = { position: camera.position.clone(), target: controls.target.clone() };
      controls.target.set(cx, floorY, cz);
      camera.position.set(cx, floorY + 10, cz + 0.001);
      controls.minPolarAngle = 0;
      controls.maxPolarAngle = 0.001;
    } else {
      controls.minPolarAngle = 0;
      controls.maxPolarAngle = Math.PI;
      if (saved) {
        camera.position.copy(saved.position);
        controls.target.copy(saved.target);
      }
    }
    controls.update();
    return topDown;
  };

  return {
    name: 'commander',
    toggleTopDown,
    setCutaway,
    get cutaway() {
      return cut;
    },
    follow,
    fixed,
    update() {
      if (campath) { // scripted camera for renders: eased between keyframes on the replay clock
        const c = camPathAt(campath, omni.clock);
        camera.position.fromArray(c.pos);
        camera.lookAt(c.at[0], c.at[1], c.at[2]);
        return;
      }
      if (controls.enabled) controls.update();
    },
  };
}
