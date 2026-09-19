import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { params, sceneUrl } from './params.js';
import { omni, showError, tickFps } from './debug.js';

// Skeleton boot: a renderer, a floor grid at floor_y and the scene manifest.
// Point clouds, AR mode, alignment, ghosts and the portal land in the next commits.

omni.mode = params.mode;
omni.scene = params.scene;
document.body.dataset.mode = params.mode;

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = params.mode === 'ar' ? null : new THREE.Color(0x0b0f14);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.05, 50);
camera.position.set(0, 1.5, 3);

// Everything recorded goes under sceneRoot; the alignment nudges move only this group.
const sceneRoot = new THREE.Group();
scene.add(sceneRoot);

const grid = new THREE.GridHelper(10, 20, 0x3a5068, 0x223040);
grid.position.y = -1.3;
sceneRoot.add(grid);
sceneRoot.add(new THREE.AxesHelper(0.5));

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, -2);
controls.update();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

renderer.setAnimationLoop((time) => {
  tickFps(time);
  controls.update();
  renderer.render(scene, camera);
});

const status = document.getElementById('status');
fetch(sceneUrl('manifest.json'))
  .then(async (r) => {
    if (!r.ok) throw new Error(`manifest.json returned ${r.status} for scene "${params.scene}" (${r.url})`);
    const m = await r.json();
    omni.manifest = m;
    if (typeof m.floor_y === 'number') grid.position.y = m.floor_y;
    status.textContent = `${m.scene}: ${m.chunks.length} chunks, ${Number(m.duration).toFixed(1)} s, wall_z ${m.wall_z}, floor_y ${m.floor_y}`;
  })
  .catch(showError);

console.log('[omni] boot', JSON.stringify(params));
