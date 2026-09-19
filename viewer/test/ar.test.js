import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupAR } from '../src/modes/ar.js';
import { ReplayClock } from '../src/clock.js';
import { FrameMeasurement, setupBenchmark } from '../src/benchmark.js';

class Element extends EventTarget {
  disabled = false;
  textContent = '';
  classes = new Set();
  classList = { add: (c) => this.classes.add(c), remove: (c) => this.classes.delete(c) };
  click() { this.dispatchEvent(new Event('click')); }
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
async function fixture({ supported = true, secure = true, overlay = true, requestError, requestErrorTimes = Infinity, setupError } = {}) {
  const elements = Object.fromEntries(['enter', 'exit', 'pre', 'hud', 'status', 'tracking', 'benchmark'].map((key) => [key, new Element()]));
  const calls = [];
  const errors = [];
  const sessions = [];
  const reference = new EventTarget();
  const xr = {
    async isSessionSupported(type) { calls.push(['support', type]); return supported; },
    async requestSession(type, options) {
      calls.push(['request', type, options]);
      if (requestError && calls.filter((call) => call[0] === 'request').length <= requestErrorTimes) throw requestError;
      const session = new EventTarget();
      session.domOverlayState = overlay ? { type: 'screen' } : null;
      session.end = async () => { calls.push(['end']); session.dispatchEvent(new Event('end')); };
      sessions.push(session);
      return session;
    },
  };
  const renderer = { setClearAlpha: (alpha) => calls.push(['alpha', alpha]), xr: {
    setFramebufferScaleFactor: (scale) => calls.push(['scale', scale]),
    setReferenceSpaceType: (space) => calls.push(['space', space]),
    async setSession() { calls.push(['setSession']); if (setupError) throw setupError; },
    getReferenceSpace: () => reference,
    getBaseLayer: () => ({ framebufferWidth: 1080, framebufferHeight: 1920 }),
  } };
  const clock = new ReplayClock({ duration: 20 });
  const scene = { background: 'old' };
  const camera = { position: { set: (...v) => calls.push(['camera', ...v]) } };
  const alignmentCloud = { visible: true };
  const omni = {};
  const mode = await setupAR({ renderer, scene, camera, alignmentCloud, clock, omni, elements, xr, secure,
    params: { fbscale: 0.75, t: 0 }, onError: (e) => errors.push(e.message), resetFps() {}, retryDelay: 1 });
  return { mode, elements, calls, errors, sessions, reference, clock, scene, alignmentCloud, omni };
}

test('AR tap requests local + overlay, configures XR before attaching, waits for tracking, and can re-enter', async () => {
  const f = await fixture();
  assert.equal(f.scene.background, null);
  assert.equal(f.alignmentCloud.visible, false);
  assert.equal(f.clock.playing, false);
  assert.equal(f.sessions.length, 0); // support probing must not request camera access
  f.elements.enter.click();
  f.elements.enter.click(); // double tap cannot request a second session
  await settle();
  assert.equal(f.sessions.length, 1);
  const request = f.calls.find((call) => call[0] === 'request');
  assert.deepEqual(request.slice(1), ['immersive-ar', {
    requiredFeatures: ['local'], optionalFeatures: ['dom-overlay'], domOverlay: { root: f.elements.hud },
  }]);
  const setIndex = f.calls.findIndex((call) => call[0] === 'setSession');
  assert.deepEqual(f.calls.slice(setIndex - 2, setIndex), [['scale', 0.75], ['space', 'local']]);
  assert.ok(f.omni.xrPresenting);
  assert.ok(f.elements.pre.classes.has('hidden'));
  assert.ok(!f.elements.hud.classes.has('hidden'));
  const frame = { getViewerPose: () => ({}) };
  f.mode.update(100, frame);
  f.mode.update(2099, frame);
  assert.equal(f.clock.playing, false);
  f.mode.update(2100, frame);
  assert.equal(f.clock.playing, true);
  assert.deepEqual(f.omni.xrFramebuffer, { width: 1080, height: 1920 });
  f.reference.dispatchEvent(new Event('reset'));
  assert.equal(f.omni.resets, 1);
  f.elements.exit.click();
  await settle();
  assert.equal(f.omni.xrPresenting, false);
  assert.equal(f.clock.playing, false);
  assert.equal(f.elements.enter.disabled, false);
  assert.ok(f.elements.hud.classes.has('hidden'));
  f.reference.dispatchEvent(new Event('reset'));
  assert.equal(f.omni.resets, 1); // listener was removed
  f.elements.enter.click();
  await settle();
  assert.equal(f.sessions.length, 2);
  assert.equal(f.omni.resets, 0);
  assert.deepEqual(f.errors, []);
});

test('unsupported or insecure AR cannot start', async () => {
  for (const options of [{ supported: false }, { secure: false }]) {
    const f = await fixture(options);
    f.elements.enter.click();
    await settle();
    assert.equal(f.sessions.length, 0);
    assert.equal(f.elements.enter.disabled, true);
    assert.match(f.elements.status.textContent, /Chrome|secure context/);
  }
});

test('denied permission, missing overlay and renderer failure restore the start UI and release any session', async () => {
  for (const options of [{ requestError: new Error('Permission denied') }, { overlay: false }, { setupError: new Error('GPU setup failed') }]) {
    const f = await fixture(options);
    f.elements.enter.click();
    await settle();
    assert.equal(f.elements.enter.disabled, false);
    assert.equal(f.omni.xrPresenting, false);
    assert.equal(f.errors.length, 1);
    assert.ok(!f.elements.pre.classes.has('hidden'));
    assert.ok(f.elements.hud.classes.has('hidden'));
    if (!options.requestError) assert.ok(f.calls.some((call) => call[0] === 'end'));
    else assert.equal(f.calls.filter((call) => call[0] === 'request').length, 1); // a denial is never retried
  }
});

test('a NotSupportedError right after a previous session is retried once inside the same tap', async () => {
  const notSupported = () => Object.assign(new Error('The specified session configuration is not supported.'), { name: 'NotSupportedError' });
  const f = await fixture({ requestError: notSupported(), requestErrorTimes: 1 });
  f.elements.enter.click();
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.calls.filter((call) => call[0] === 'request').length, 2);
  assert.equal(f.sessions.length, 1);
  assert.ok(f.omni.xrPresenting);
  assert.deepEqual(f.errors, []);
  // still failing after the retry: the normal error path, one readable message, Enter re-enabled
  const g = await fixture({ requestError: notSupported() });
  g.elements.enter.click();
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(g.calls.filter((call) => call[0] === 'request').length, 2);
  assert.equal(g.sessions.length, 0);
  assert.equal(g.errors.length, 1);
  assert.equal(g.elements.enter.disabled, false);
  assert.match(g.elements.status.textContent, /could not start/);
});

test('FPS measurement counts intervals over 10 seconds and exposes stalls in the half-second minimum', () => {
  const sample = new FrameMeasurement();
  let result;
  for (let i = 0; i <= 600; i++) result = sample.tick(i * 1000 / 60);
  assert.equal(result.frames, 600);
  assert.ok(Math.abs(result.fps - 60) < 0.01);
  assert.ok(Math.abs(result.minFps - 60) < 0.01);
  sample.reset();
  sample.tick(0);
  sample.tick(1000);
  result = sample.tick(10000);
  assert.ok(result.minFps < 1);
});

test('lost tracking during startup restarts the two-second hold; external session end restores Enter', async () => {
  const f = await fixture();
  f.elements.enter.click();
  await settle();
  const tracked = { getViewerPose: () => ({}) };
  f.mode.update(0, tracked);
  f.mode.update(1500, { getViewerPose: () => null });
  assert.equal(f.omni.tracking, false);
  f.mode.update(2000, tracked);
  f.mode.update(3999, tracked);
  assert.equal(f.clock.playing, false);
  f.mode.update(4000, tracked);
  assert.equal(f.clock.playing, true);
  await f.sessions[0].end();
  assert.equal(f.elements.enter.disabled, false);
  assert.equal(f.omni.xrPresenting, false);
});

test('benchmark freezes full replay, measures only after warmup, and cancels changes or session loss', () => {
  const clock = new ReplayClock({ duration: 60 });
  const omni = { xrPresenting: true, tracking: true, points: 400000, resets: 0,
    xrFramebuffer: { width: 1080, height: 1920 }, alignment: { x: 0 }, aligning: false };
  const button = new Element();
  const status = new Element();
  const benchmark = setupBenchmark({ clock, omni, button, status, params: { scene: 'stress', budget: 400000, fbscale: 1 } });
  button.click();
  assert.equal(clock.playing, false);
  assert.equal(clock.time, 60);
  const frame = {};
  benchmark.update(0, frame);
  benchmark.update(1999, frame);
  assert.equal(omni.benchmark, null);
  for (let i = 0; i <= 600; i++) benchmark.update(2000 + i * 1000 / 60, frame);
  assert.ok(Math.abs(omni.benchmark.fps - 60) < 0.01);
  assert.equal(omni.benchmark.points, 400000);
  assert.deepEqual(omni.benchmark.xrFramebuffer, { width: 1080, height: 1920 });
  assert.equal(button.disabled, false);
  for (const change of [() => { omni.alignment.x += 0.01; }, () => { omni.resets += 1; }, () => clock.play()]) {
    button.click();
    benchmark.update(0, frame);
    benchmark.update(2000, frame);
    change();
    benchmark.update(2100, frame);
    assert.equal(omni.benchmark, null);
    assert.match(status.textContent, /cancelled/);
  }
  button.click();
  omni.xrPresenting = false;
  benchmark.update(0, undefined);
  assert.match(status.textContent, /AR ended/);
  assert.equal(button.disabled, true);
});
