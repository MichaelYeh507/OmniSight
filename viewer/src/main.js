import * as THREE from 'three';
import { params } from './params.js';
import { omni, showError, tickFps } from './debug.js';
import { loadScene } from './scene-loader.js';
import { drawCountAt } from './scene-data.js';
import { PointCloud, maxPointSize } from './points.js';
import { ReplayClock } from './clock.js';
import { setupHud } from './hud.js';
import { setupCommander } from './modes/commander.js';

const $ = (id) => document.getElementById(id);

async function boot() {
  omni.mode = params.mode;
  omni.scene = params.scene;
  document.body.dataset.mode = params.mode;
  const status = $('status');

  // --- renderer, scene, camera
  const renderer = new THREE.WebGLRenderer({
    antialias: params.mode !== 'ar', // MSAA is passed to the XR layer; keep it off in AR for fill rate
    alpha: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  $('app').appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.05, 50);
  camera.position.set(0, 1.5, 3);

  // everything recorded lives under sceneRoot; alignment nudges move only this group
  const sceneRoot = new THREE.Group();
  scene.add(sceneRoot);
  omni.sceneRoot = sceneRoot;

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // --- data
  const data = await loadScene((done, total, label) => {
    status.textContent = `loading ${done}/${total} (${label})`;
  });
  omni.data = data;
  status.textContent = `${data.manifest.scene}: ${data.static.count.toLocaleString()} points, ${data.duration.toFixed(1)} s, ${(data.bytes / 1e6).toFixed(1)} MB`;

  // --- point clouds
  const maxPx = Math.min(24, maxPointSize(renderer));
  const staticCloud = new PointCloud(data.static, { round: params.round, maxPx, sizeScale: params.psize });
  sceneRoot.add(staticCloud.object);
  let alignmentCloud = null;
  if (data.alignment) {
    alignmentCloud = new PointCloud(data.alignment, { ignoreTime: true, round: params.round, maxPx, sizeScale: params.psize });
    sceneRoot.add(alignmentCloud.object);
  }

  // --- clock + mode + hud
  const clock = new ReplayClock({ duration: data.duration, t: params.t, speed: params.speed });
  omni.clockObj = clock;

  if (params.mode === 'ar') {
    console.warn('[omni] AR mode is not wired yet (next commit); running commander mode');
    document.body.dataset.mode = 'commander';
  }
  const mode = setupCommander({ renderer, scene, camera, sceneRoot, data, alignmentCloud });
  const hud = setupHud({ clock, manifest: data.manifest, onTopDown: mode.toggleTopDown });
  $('hud').classList.remove('hidden');
  $('pre').classList.add('hidden');

  // --- render loop
  renderer.setAnimationLoop((time) => {
    tickFps(time);
    const t = clock.update(time);
    staticCloud.setClock(t);
    let n = drawCountAt(data.static, t);
    if (params.budget > 0) n = Math.min(n, params.budget);
    staticCloud.setDrawCount(n);
    omni.clock = t;
    omni.points = staticCloud.drawCount + (alignmentCloud && alignmentCloud.visible ? alignmentCloud.count : 0);
    mode.update(time);
    hud.update(time);
    renderer.render(scene, camera);
  });

  console.log('[omni] ready', JSON.stringify({ ...params, points: data.static.count, duration: data.duration }));
}

boot().catch(showError);
