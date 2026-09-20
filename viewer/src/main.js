import * as THREE from 'three';
import { params } from './params.js';
import { omni, showError, tickFps, resetFps } from './debug.js';
import { loadScene } from './scene-loader.js';
import { drawCountAt, parseWall, parseCamPath, WALL_CLIP_DEPTH } from './scene-data.js';
import { PointCloud, maxPointSize } from './points.js';
import { ReplayClock } from './clock.js';
import { setupHud } from './hud.js';
import { setupCommander } from './modes/commander.js';
import { setupAR } from './modes/ar.js';
import { setupBenchmark } from './benchmark.js';
import { setupAlignment } from './alignment.js';
import { Ghosts } from './ghosts.js';
import { Responders } from './responder.js';
import { Portal } from './portal.js';
import { Outlines } from './outlines.js';
import { setupMinimap } from './minimap.js';

const $ = (id) => document.getElementById(id);
export const XRAY_FADE = 0.45; // seconds for the portal iris to open or close when x-ray is toggled

async function boot() {
  omni.mode = params.mode;
  omni.scene = params.scene;
  omni.budget = params.budget;
  omni.fbscale = params.fbscale;
  document.body.dataset.mode = params.mode;
  document.body.dataset.look = params.look;
  omni.look = params.look;
  document.body.dataset.capture = params.capture ? '1' : '';
  omni.capture = params.capture;
  document.body.dataset.ui = params.ui || '';
  omni.ui = params.ui;
  if (!params.hud || params.feed) document.body.dataset.hud = '0'; // a bare layer for renders
  if (params.mapsize) document.body.dataset.maponly = '1'; // minimap showcase: only the map, centred
  const campath = parseCamPath(params.campath);
  if (params.campath && !campath) showError(new Error('Bad ?campath=: use t:x,y,z@ax,ay,az;t:...'));
  const status = $('status');

  // --- renderer, scene, camera
  const renderer = new THREE.WebGLRenderer({
    antialias: params.mode !== 'ar', // MSAA is passed to the XR layer; keep it off in AR for fill rate
    alpha: true,
    powerPreference: 'high-performance',
  });
  renderer.localClippingEnabled = true; // responder trails are clipped at the wall plane in x-ray (material clipping planes)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  $('app').appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(params.fov, window.innerWidth / window.innerHeight, 0.05, 50);
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
  // the wall the portal sits on: the contract's z = wall_z unless ?wall= names another plane (room012's door wall is -x:-0.69)
  const wall = parseWall(params.wall, data.wallZ);
  if (params.wall && !wall) showError(new Error(`Bad ?wall=${params.wall}: use z:-1.8, -x:-0.69 or nx,ny,nz,d`));
  omni.wall = wall;

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
  if (params.feed) { // synthetic camera feed for renders: what a camera would see, recorded colours, no reveal
    staticCloud.setLook('color');
    staticCloud.setIgnoreTime(true);
    staticCloud.uniforms.uSizeScale.value *= 3.2;
    staticCloud.uniforms.uRound.value = 1;
    staticCloud.uniforms.uBrightness.value = 0.85;
    if (alignmentCloud) { alignmentCloud.setLook('color'); alignmentCloud.uniforms.uSizeScale.value *= 2.4; }
  }

  // --- person ghosts (drawn through walls; hold + fade handled inside)
  let ghosts = null;
  if (data.people && data.people.totalPoints > 0 && !params.feed) {
    ghosts = new Ghosts(data.people, { maxPx: Math.min(24, maxPointSize(renderer)), sizeScale: params.psize });
    ghosts.setLook(params.look);
    sceneRoot.add(ghosts.group);
  }
  omni.ghostFrames = data.people ? data.people.entries.length : 0;

  // --- object outlines: the hand-annotated 3D sketch (<scene>/outlines.json), hot-red wireframes drawn through the wall
  let outlines = null;
  if (params.outlines && data.outlines.length && !params.feed) {
    outlines = new Outlines(data.outlines, { staticData: data.static, labels: params.outlinelabels, hole: params.portalStyle === 'soft' ? staticCloud.uniforms.uHole : null });
    outlines.setLook(params.look);
    sceneRoot.add(outlines.group);
  }
  omni.outlineCount = outlines ? outlines.items.length : 0;

  // --- responder frustum + trail, and the portal (AR x-ray mode, the ?ui=ar phone preview, or ?portaldebug=1)
  let responders = null;
  if (data.trajectory.length && !params.feed) {
    responders = new Responders(data.trajectory, data.manifest.sources || []); // one frustum + trail per source id
    sceneRoot.add(responders.group);
  }
  let portal = null;
  const throughWall = params.mode === 'ar' || params.portaldebug || params.ui === 'ar';
  if (params.portal && wall && throughWall && !params.feed) {
    portal = new Portal({ plane: wall, wallZ: data.wallZ, radius: params.portalr, style: params.portalStyle });
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
    : setupCommander({ renderer, scene, camera, sceneRoot, data, alignmentCloud, staticCloud, look: params.look, cutaway: params.feed ? false : (params.cutaway ?? true), cam: params.cam, campos: params.campos, camat: params.camat, campath, cut: { x: params.cutx, y: params.cuty, z: params.cutz }, ui: params.ui });
  omni.cam = params.mode === 'ar' ? 'xr' : params.cam;
  if (params.mode === 'ar') {
    setupAlignment({ sceneRoot, alignmentCloud, overrides: params.align, omni });
  }
  const benchmark = setupBenchmark({ clock, omni, params, button: $('btn-benchmark'), status: $('benchmark-status') });

  // --- x-ray on/off. Off is the plain camera view: nothing recorded is drawn, the HUD stays. On opens the portal
  // iris over XRAY_FADE seconds (the render script drives `progress` itself so the switch is frame-exact).
  omni.xray = { on: params.xray, progress: params.xray ? 1 : 0, animate: true };
  const hud = setupHud({ clock, manifest: data.manifest, renderer: params.renderer, onTopDown: mode.toggleTopDown,
    onCutaway: mode.setCutaway ? () => (omni.cutaway = mode.setCutaway(!mode.cutaway)) : null, cutaway: !!mode.cutaway,
    onXray: () => omni.setView(omni.view === 'camera' ? 'xray' : 'camera'), onView: (v) => omni.setView(v) });
  omni.setXray = (on, progress) => {
    omni.xray.on = !!on;
    if (Number.isFinite(progress)) {
      omni.xray.animate = false;
      omni.xray.progress = Math.min(1, Math.max(0, progress));
    } else omni.xray.animate = true;
    document.body.dataset.xray = omni.xray.on ? '1' : '0';
    // keep the three-way view in step with a plain on/off call (the HUD button, key x, the render's --xray-at)
    if (!omni.xray.on) omni.view = 'camera';
    else if (omni.view === 'camera' || !omni.view) omni.view = document.body.dataset.look === 'color' ? 'natural' : 'xray';
    hud.setView?.(omni.view);
    hud.setXray(omni.xray.on);
    return omni.xray.on;
  };
  omni.setXray(params.view !== 'camera', params.view !== 'camera' ? 1 : 0);
  omni.xray.animate = true;
  // three-way view: camera (nothing revealed), xray (the cyan map), natural (the same reveal in the recorded colours)
  omni.view = params.view;
  omni.setView = (view, progress) => {
    view = ['camera', 'xray', 'natural'].includes(view) ? view : 'xray';
    omni.view = view;
    const look = view === 'natural' ? 'color' : params.look;
    staticCloud.setLook(look);
    if (alignmentCloud) alignmentCloud.setLook(look);
    if (ghosts) ghosts.setLook(look);
    if (outlines) outlines.setLook(look);
    document.body.dataset.look = look;
    omni.setXray(view !== 'camera', progress);
    hud.setView(view);
    return view;
  };
  omni.setView(params.view, params.view !== 'camera' ? 1 : 0);
  omni.xray.animate = true;
  omni.wheel = hud.wheel || null; // renders script its open/select/close animation via omni.wheel.showAt
  omni.cutaway = !!mode.cutaway;
  hud.setResponders(responders ? responders.legend : []);
  $('legend-outlines')?.toggleAttribute('hidden', !outlines);
  // --- team map: top-down minimap of what was scanned, the teammates who recorded, the person and the viewer
  const minimap = params.map && !params.feed && $('minimap') ? setupMinimap({
    canvas: $('minimap'), staticData: data.static, floorY: data.floorY, wall, size: params.mapsize || (window.innerWidth < 480 ? 120 : 150),
    responders: responders ? responders.items.map((r) => ({ source: r.source, color: r.colors.frustum })) : [],
  }) : null;
  if (!minimap) $('map')?.setAttribute('hidden', '');
  if (params.mode !== 'ar') {
    $('hud').classList.remove('hidden');
    $('pre').classList.add('hidden');
  }

  // --- render loop
  const _inv = new THREE.Matrix4();
  const _pos = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  const _hole = new THREE.Vector3();
  const headingOf = (q) => { _dir.set(0, 0, -1).applyQuaternion(q); return Math.atan2(_dir.x, -_dir.z); }; // 0 = looking along -Z
  let prevTime = null;
  renderer.setAnimationLoop((time, frame) => {
    tickFps(time);
    const dt = prevTime === null ? 0 : Math.min(0.1, (time - prevTime) / 1000);
    prevTime = time;
    const t = clock.update(time);
    const xray = omni.xray;
    if (xray.animate) xray.progress = Math.min(1, Math.max(0, xray.progress + (xray.on ? 1 : -1) * dt / XRAY_FADE));
    const reveal = omni.aligning ? 1 : xray.progress; // aligning always shows the map: the wall cloud has to be lined up against it
    staticCloud.setClock(t);
    if (!params.feed) {
      let n = drawCountAt(data.static, t);
      if (params.budget > 0) n = Math.min(n, params.budget);
      staticCloud.setDrawCount(n);
    }
    staticCloud.visible = params.feed || reveal > 0;
    if (alignmentCloud && params.ui === 'ar') alignmentCloud.visible = !!omni.aligning; // the phone preview hides the outside wall like AR x-ray does
    omni.clock = t;
    omni.points = (staticCloud.visible ? staticCloud.drawCount : 0) + (alignmentCloud && alignmentCloud.visible ? alignmentCloud.count : 0);
    if (ghosts) ghosts.setReveal(reveal);
    omni.ghost = ghosts ? ghosts.update(t) : null;
    if (ghosts) ghosts.face(renderer.xr.isPresenting ? renderer.xr.getCamera() : camera, sceneRoot);
    if (omni.ghost && omni.ghost.visible) omni.points += omni.ghost.count;
    omni.cutaway = !!mode.cutaway;
    if (responders) responders.group.visible = reveal > 0;
    omni.responders = responders ? responders.update(t) : [];
    omni.responder = omni.responders[0] || null;
    if (mode.follow && responders && responders.items[0]) {
      // first person on source 0: the camera takes the frustum's world pose; the frustum itself would sit on the lens, so hide it
      const lead = responders.items[0];
      lead.frustum.visible = false;
      lead.frustum.getWorldPosition(camera.position);
      lead.frustum.getWorldQuaternion(camera.quaternion);
    }
    omni.outlines = outlines ? outlines.update(t, reveal) : [];
    if (minimap) {
      const cam = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
      sceneRoot.updateMatrixWorld();
      _inv.copy(sceneRoot.matrixWorld).invert();
      _pos.setFromMatrixPosition(cam.matrixWorld).applyMatrix4(_inv);
      _dir.set(0, 0, -1).transformDirection(cam.matrixWorld).transformDirection(_inv);
      const viewer = { position: [_pos.x, _pos.y, _pos.z], heading: Math.atan2(_dir.x, -_dir.z), fov: cam.fov ? cam.fov * (cam.aspect || 1) : 60 };
      const bearingTo = (p) => Math.atan2(p[0] - _pos.x, -(p[2] - _pos.z)) * 180 / Math.PI;
      const marks = (omni.responders || []).map((r) => ({ deg: bearingTo(r.position), kind: 'team' }));
      if (omni.ghost && omni.ghost.visible) marks.push({ deg: bearingTo(omni.ghost.centroid), kind: 'person' });
      hud.setHeading(viewer.heading * 180 / Math.PI, marks);
      minimap.update(t, {
        responders: responders ? responders.items.map((r) => r.state && { source: r.source, position: r.state.position, heading: headingOf(r.frustum.quaternion), label: `R${r.source + 1}` }).filter(Boolean) : [],
        ghost: omni.ghost, viewer, reveal,
      });
    }
    if (portal) {
      // the portal is for x-ray mode: off while aligning (the wall cloud must be fully visible) and before the XR session
      portal.setEnabled(params.portaldebug || params.ui === 'ar' || (omni.xrPresenting && !omni.aligning));
      portal.setOpen(reveal);
      omni.portal = portal.update(renderer.xr.isPresenting ? renderer.xr.getCamera() : camera, sceneRoot);
      // looking in from outside: hide the wall's own points (and anything outside) so the window looks into the room
      const clipping = omni.portal.enabled && omni.portal.outside && !omni.aligning;
      staticCloud.setWallClip(wall, clipping ? WALL_CLIP_DEPTH : null);
      // soft x-ray: the room fades in around the gaze hit on the wall (world space), the spot irising with the reveal
      if (portal.style === 'soft') {
        if (clipping && reveal > 0) staticCloud.setHole(_hole.fromArray(omni.portal.hit).applyMatrix4(sceneRoot.matrixWorld), portal.radius * reveal, 0.45);
        else staticCloud.setHole(null);
      }
      if (responders && clipping !== omni.trailClipped) { // the teammate's path beside the viewer would cut across the frame
        omni.trailClipped = clipping;
        responders.setWallClip(clipping ? wall : null, 0, sceneRoot.matrixWorld);
      }
    }
    mode.update(time, frame);
    benchmark.update(time, frame);
    hud.update(time);
    renderer.render(scene, camera);
  });

  console.log('[omni] ready', JSON.stringify({ ...params, wall, points: data.static.count, duration: data.duration }));
}

boot().catch(showError);
