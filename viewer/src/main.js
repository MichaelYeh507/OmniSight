import * as THREE from 'three';
import { params } from './params.js';
import { omni, showError, tickFps, resetFps } from './debug.js';
import { loadScene } from './scene-loader.js';
import { drawCountAt } from './scene-data.js';
import { PointCloud, maxPointSize } from './points.js';
import { ReplayClock } from './clock.js';
import { setupHud } from './hud.js';
import { setupCommander } from './modes/commander.js';
import { setupAR } from './modes/ar.js';
import { setupBenchmark } from './benchmark.js';
import { setupAlignment } from './alignment.js';
import { Ghosts } from './ghosts.js';
import { Responder } from './responder.js';
import { Portal } from './portal.js';

const $ = (id) => document.getElementById(id);

async function boot() {
  omni.mode = params.mode;
  omni.scene = params.scene;
  omni.budget = params.budget;
  omni.fbscale = params.fbscale;
  document.body.dataset.mode = params.mode;
  document.body.dataset.look = params.look;
  omni.look = params.look;
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

  const resize = () => {
    if (renderer.xr.isPresenting) return;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', resize);
  renderer.xr.addEventListener('sessionend', resize);

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
  staticCloud.setLook(params.look);
  if (alignmentCloud) alignmentCloud.setLook(params.look);
  if (params.look === 'blueprint') staticCloud.uniforms.uSizeScale.value *= 0.5; // stippled surfaces instead of solid slabs

  // Optional Gaussian-splat renderer (?renderer=spark): draw the same static points as
  // oriented splats for a smooth surface. Keep the points cloud wired but hidden so the
  // clock, commander and cutaway systems keep working; fall back to points if Spark fails.
  if (params.renderer === 'spark') {
    try {
      const { SparkCloud } = await import('./spark.js');
      // Splat the whole scene -- interior chunks AND the wall-exterior alignment cloud --
      // so all of it is splats. Hide the interior points and drop the alignment points
      // entirely (its geometry is in the splats now, and commander would otherwise
      // re-show it as dots when cutaway toggles).
      const sparkCloud = new SparkCloud(renderer, scene, [data.static, data.alignment], { sizeScale: params.psize });
      sceneRoot.add(sparkCloud.object);
      staticCloud.object.visible = false;
      if (alignmentCloud) {
        sceneRoot.remove(alignmentCloud.object);
        alignmentCloud = null;
      }
      omni.renderer = 'spark';
    } catch (err) {
      console.error('[omni] spark renderer failed; falling back to points', err);
      omni.renderer = 'points';
    }
  }

  // --- person ghosts (drawn through walls; hold + fade handled inside)
  let ghosts = null;
  if (data.people && data.people.totalPoints > 0) {
    ghosts = new Ghosts(data.people, { maxPx: Math.min(32, maxPointSize(renderer)), sizeScale: params.psize });
    ghosts.setLook(params.look);
    sceneRoot.add(ghosts.group);
  }
  omni.ghostFrames = data.people ? data.people.entries.length : 0;

  // --- responder frustum + trail, and the portal (AR x-ray mode only, or ?portaldebug=1)
  let responder = null;
  if (data.trajectory.length) {
    responder = new Responder(data.trajectory);
    sceneRoot.add(responder.group);
  }
  let portal = null;
  if (params.portal && data.wallZ !== null && (params.mode === 'ar' || params.portaldebug)) {
    portal = new Portal({ wallZ: data.wallZ });
    sceneRoot.add(portal.group);
  }

  // --- clock + mode + hud
  // ?t= at or past the end means "show the finished map": start paused there instead of wrapping to 0
  const clock = new ReplayClock({ duration: data.duration, t: params.t, speed: params.speed, playing: params.t < data.duration });
  omni.clockObj = clock;

  if (params.bench) { clock.seek(data.duration); clock.pause(); }
  const mode = params.mode === 'ar'
    ? await setupAR({ renderer, scene, camera, alignmentCloud, clock, params, omni,
      onError: showError, resetFps, elements: {
        enter: $('btn-enter-ar'), exit: $('btn-exit-ar'), pre: $('pre'), hud: $('hud'),
        status: $('ar-status'), tracking: $('ro-tracking'), benchmark: $('btn-benchmark'),
        error: $('error-banner'), xrError: $('xr-error'),
      } })
    : setupCommander({ renderer, scene, camera, sceneRoot, data, alignmentCloud, staticCloud, look: params.look, cutaway: params.cutaway ?? true });
  if (params.mode === 'ar') {
    setupAlignment({ sceneRoot, alignmentCloud, overrides: params.align, omni });
  }
  const benchmark = setupBenchmark({ clock, omni, params, button: $('btn-benchmark'), status: $('benchmark-status') });
  const hud = setupHud({ clock, manifest: data.manifest, onTopDown: mode.toggleTopDown, onCutaway: mode.setCutaway ? () => (omni.cutaway = mode.setCutaway(!mode.cutaway)) : null, cutaway: !!mode.cutaway });
  omni.cutaway = !!mode.cutaway;
  if (params.mode !== 'ar') {
    $('hud').classList.remove('hidden');
    $('pre').classList.add('hidden');
  }

  // --- render loop
  renderer.setAnimationLoop((time, frame) => {
    tickFps(time);
    const t = clock.update(time);
    staticCloud.setClock(t);
    let n = drawCountAt(data.static, t);
    if (params.budget > 0) n = Math.min(n, params.budget);
    staticCloud.setDrawCount(n);
    omni.clock = t;
    omni.points = staticCloud.drawCount + (alignmentCloud && alignmentCloud.visible ? alignmentCloud.count : 0);
    omni.ghost = ghosts ? ghosts.update(t) : null;
    if (omni.ghost && omni.ghost.visible) omni.points += omni.ghost.count;
    omni.cutaway = !!mode.cutaway;
    omni.responder = responder ? responder.update(t) : null;
    if (portal) {
      // the portal is for x-ray mode: off while aligning (the wall cloud must be fully visible) and before the XR session
      portal.setEnabled(params.portaldebug || (omni.xrPresenting && !omni.aligning));
      omni.portal = portal.update(renderer.xr.isPresenting ? renderer.xr.getCamera() : camera, sceneRoot);
    }
    mode.update(time, frame);
    benchmark.update(time, frame);
    hud.update(time);
    renderer.render(scene, camera);
  });

  console.log('[omni] ready', JSON.stringify({ ...params, points: data.static.count, duration: data.duration }));
}

boot().catch(showError);
