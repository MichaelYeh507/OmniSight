// Dependency-free Chrome DevTools smoke check. Start `npm run dev` first.
// Screenshots and an isolated browser profile stay in gitignored node_modules/.cache.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const executable = process.env.OMNI_CHROME || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);
if (!executable) throw new Error('Set OMNI_CHROME to a Chrome/Chromium executable.');
// OMNI_URL=https://michaelyeh507.github.io/OmniSight/ runs the same checks against the deployed site.
const base = (process.env.OMNI_URL || 'http://127.0.0.1:5173/OmniSight/').replace(/\/?$/, '/');
const cache = resolve('node_modules/.cache');
await mkdir(cache, { recursive: true });
const output = await mkdtemp(resolve(cache, 'omni-smoke-'));
const browser = spawn(executable, [
  '--headless=new', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${output}/profile`,
  '--window-size=1280,900', 'about:blank',
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let ws;
try {
  const endpoint = await new Promise((resolveEndpoint, reject) => {
    const timeout = setTimeout(() => reject(new Error('Chrome did not expose DevTools within 20 s')), 20000);
    let stderr = '';
    browser.on('error', reject);
    browser.on('exit', (code) => reject(new Error(`Chrome exited ${code}: ${stderr}`)));
    browser.stderr.on('data', (data) => {
      stderr += data;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timeout); resolveEndpoint(match[1]); }
    });
  });
  ws = new WebSocket(endpoint);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
  let serial = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const task = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) task.reject(new Error(JSON.stringify(message.error)));
      else task.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params.exceptionDetails);
    } else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      errors.push(message.params.args);
    }
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++serial;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const command = (method, params) => send(method, params, sessionId);
  await command('Runtime.enable');
  await command('Page.enable');
  const evaluate = async (expression) => {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const waitFor = async (expression) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await new Promise((ok) => setTimeout(ok, 100));
    }
    throw new Error(`Timed out: ${expression}`);
  };
  await command('Page.navigate', { url: `${base}?mode=commander&scene=box` });
  await waitFor('!!window.__omni?.clockObj && window.__omni.points > 0');
  await evaluate('window.__omni.clockObj.pause(); window.__omni.clockObj.seek(20)');
  await waitFor('window.__omni.clock >= 20');
  const commander = await evaluate(`({mode: __omni.mode, points: __omni.points,
    errors: __omni.errors, canvas: !!document.querySelector('canvas'),
    hud: !document.getElementById('hud').classList.contains('hidden')})`);
  assert.equal(commander.mode, 'commander');
  assert.ok(commander.canvas && commander.hud && commander.points > 10000);
  assert.deepEqual(commander.errors, []);
  await evaluate("document.getElementById('btn-topdown').click()");
  assert.equal(await evaluate("document.getElementById('btn-topdown').classList.contains('active')"), true);
  const screenshot = await command('Page.captureScreenshot', { format: 'png' });
  await writeFile(resolve(output, 'commander.png'), Buffer.from(screenshot.data, 'base64'));
  // Ghosts on Dev C's fake scene: hidden before 5 s, seen 5-11.9 s, then a 15 s fade with a last-seen label.
  await command('Page.navigate', { url: `${base}?mode=commander&scene=fake&t=8` });
  await waitFor('!!window.__omni?.clockObj && window.__omni.points > 0');
  await evaluate('__omni.clockObj.pause(); __omni.clockObj.seek(8)');
  await waitFor('__omni.clock >= 8 && !!__omni.ghost');
  const seen = await evaluate('({...__omni.ghost, frames: __omni.ghostFrames, errors: __omni.errors})');
  assert.equal(seen.frames, 70);
  assert.ok(seen.visible && seen.seen && seen.alpha === 1 && seen.count > 0, JSON.stringify(seen));
  assert.deepEqual(seen.errors, []);
  await evaluate("__omni.clockObj.seek(9); document.getElementById('hud').classList.add('hidden')");
  await new Promise((ok) => setTimeout(ok, 400));
  const ghostShot = await command('Page.captureScreenshot', { format: 'png' });
  await writeFile(resolve(output, 'ghost-seen.png'), Buffer.from(ghostShot.data, 'base64'));
  await evaluate("document.getElementById('hud').classList.remove('hidden'); __omni.clockObj.seek(19)");
  await waitFor('__omni.clock >= 19');
  const fading = await evaluate('__omni.ghost');
  await evaluate("document.getElementById('hud').classList.add('hidden')");
  await new Promise((ok) => setTimeout(ok, 300));
  const fadeShot = await command('Page.captureScreenshot', { format: 'png' });
  await writeFile(resolve(output, 'ghost-fading.png'), Buffer.from(fadeShot.data, 'base64'));
  await evaluate("document.getElementById('hud').classList.remove('hidden')");
  assert.ok(fading.visible && !fading.seen && fading.alpha > 0 && fading.alpha < 1 && fading.lastSeen === 7, JSON.stringify(fading));
  await evaluate('__omni.clockObj.seek(2)');
  await waitFor('__omni.clock < 3');
  assert.equal(await evaluate('__omni.ghost'), null);
  assert.equal(await evaluate("__omni.sceneRoot.getObjectByName('ghosts').visible"), false);
  // Responder frustum + trail on the fake trajectory (201 poses over 20 s).
  await evaluate('__omni.clockObj.seek(12)');
  await waitFor('__omni.clock >= 12 && !!__omni.responder');
  const responder = await evaluate('__omni.responder');
  assert.equal(responder.index, 120);
  assert.equal(responder.trailPoints, 121);
  assert.ok(responder.position[2] < -1.8, `responder should be inside the room by 12 s: ${JSON.stringify(responder.position)}`);
  assert.equal(await evaluate("__omni.sceneRoot.getObjectByName('responder').visible"), true);
  await evaluate("document.getElementById('hud').classList.add('hidden')");
  await new Promise((ok) => setTimeout(ok, 300));
  const responderShot = await command('Page.captureScreenshot', { format: 'png' });
  await writeFile(resolve(output, 'responder.png'), Buffer.from(responderShot.data, 'base64'));
  await evaluate("document.getElementById('hud').classList.remove('hidden')");
  assert.equal(await evaluate("document.getElementById('legend-responders').hidden"), true); // one walkthrough: no responder legend
  // Two recorded walkthroughs replayed together (`two`, from make-scene --sources 2): one frustum + trail per source id, labelled from manifest.sources.
  await command('Page.navigate', { url: `${base}?mode=commander&scene=two&t=18&cutaway=0` });
  await waitFor('!!window.__omni?.clockObj && window.__omni.points > 0');
  await evaluate('__omni.clockObj.pause(); __omni.clockObj.seek(18)');
  await waitFor('__omni.clock >= 18 && Array.isArray(__omni.responders) && __omni.responders.length === 2');
  const two = await evaluate(`({responders: __omni.responders, sources: __omni.data.manifest.sources.map((s) => s.id),
    groups: __omni.sceneRoot.getObjectByName('responders').children.map((g) => [g.name, g.visible]),
    legendHidden: document.getElementById('legend-responders').hidden,
    legendRows: [...document.querySelectorAll('#legend-responders .legend-responder')].map((r) => r.textContent), errors: __omni.errors})`);
  assert.deepEqual(two.sources, [0, 1]);
  assert.deepEqual(two.responders.map((r) => r.source), [0, 1]);
  assert.ok(Math.hypot(...two.responders[0].position.map((v, k) => v - two.responders[1].position[k])) > 0.5, `responders apart at 18 s (different final legs): ${JSON.stringify(two.responders)}`);
  assert.deepEqual(two.groups, [['responder', true], ['responder-1', true]]);
  assert.equal(two.legendHidden, false);
  assert.deepEqual(two.legendRows, ['Fake responder', 'Fake responder 2']);
  assert.deepEqual(two.errors, []);
  await evaluate("document.getElementById('hud').classList.add('hidden')");
  await new Promise((ok) => setTimeout(ok, 300));
  const twoShot = await command('Page.captureScreenshot', { format: 'png' });
  await writeFile(resolve(output, 'responders-two.png'), Buffer.from(twoShot.data, 'base64'));
  await evaluate("document.getElementById('hud').classList.remove('hidden')");
  // Clean capture for screen recordings: ?capture=1 leaves only the honesty caption; the h key toggles it.
  await command('Page.navigate', { url: `${base}?mode=commander&scene=fake&capture=1&t=9` });
  await waitFor('!!window.__omni?.clockObj && window.__omni.points > 0');
  const shown = (id) => `getComputedStyle(document.getElementById('${id}')).display !== 'none'`;
  const capture = await evaluate(`({flag: __omni.capture, body: document.body.dataset.capture, caption: ${shown('caption')},
    controls: ${shown('controls')}, readout: ${shown('readout')}, legend: ${shown('legend')}, errors: __omni.errors})`);
  assert.deepEqual(capture, { flag: true, body: '1', caption: true, controls: false, readout: false, legend: false, errors: [] });
  await evaluate('__omni.clockObj.pause(); __omni.clockObj.seek(9)');
  await waitFor('__omni.clock >= 9');
  await new Promise((ok) => setTimeout(ok, 300));
  const captureShot = await command('Page.captureScreenshot', { format: 'png' });
  await writeFile(resolve(output, 'capture.png'), Buffer.from(captureShot.data, 'base64'));
  await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h' }))");
  assert.deepEqual(await evaluate(`({flag: __omni.capture, controls: ${shown('controls')}, caption: ${shown('caption')}})`), { flag: false, controls: true, caption: true });
  await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h' }))");
  assert.equal(await evaluate(shown('controls')), false);
  // Portal depth trick, forced on in commander mode: the hole follows the camera's forward ray onto the wall plane.
  await command('Page.navigate', { url: `${base}?mode=commander&scene=fake&portaldebug=1&cutaway=0` });
  await waitFor('!!window.__omni?.portal && __omni.portal.enabled');
  // pause before seeking to the end: a playing clock at t == duration wraps to 0 on the next frame
  await evaluate('__omni.clockObj.pause(); __omni.clockObj.seek(20)');
  await waitFor('__omni.clock >= 20 && __omni.points >= __omni.data.static.count');
  const portal = await evaluate('({...__omni.portal, visible: __omni.sceneRoot.getObjectByName("portal").visible, errors: __omni.errors})');
  assert.ok(portal.visible && !portal.miss && Math.abs(portal.hit[2] - (-1.8)) < 1e-6, JSON.stringify(portal));
  assert.deepEqual(portal.errors, []);
  await evaluate("__omni.clockObj.pause(); document.getElementById('hud').classList.add('hidden')");
  await new Promise((ok) => setTimeout(ok, 300));
  const portalShot = await command('Page.captureScreenshot', { format: 'png' });
  await writeFile(resolve(output, 'portal-debug.png'), Buffer.from(portalShot.data, 'base64'));
  // same view without the portal, for comparison: no portal object at all in plain commander mode
  await command('Page.navigate', { url: `${base}?mode=commander&scene=fake&cutaway=0` });
  await waitFor('!!window.__omni?.clockObj && window.__omni.points > 0');
  assert.equal(await evaluate("__omni.sceneRoot.getObjectByName('portal') ? true : false"), false);
  await evaluate("__omni.clockObj.pause(); __omni.clockObj.seek(20); document.getElementById('hud').classList.add('hidden')");
  await waitFor('__omni.clock >= 20 && __omni.points >= __omni.data.static.count');
  await new Promise((ok) => setTimeout(ok, 300));
  const noPortalShot = await command('Page.captureScreenshot', { format: 'png' });
  await writeFile(resolve(output, 'portal-off.png'), Buffer.from(noPortalShot.data, 'base64'));
  await evaluate("document.getElementById('hud').classList.remove('hidden')");
  // Phone-screen preview (?ui=ar): the AR HUD over a transparent page. ?xray=0 is the camera view (nothing recorded drawn,
  // legend hidden); setXray opens the portal iris; the HUD button animates it; ?wall= puts the portal on another plane.
  await command('Page.navigate', { url: `${base}?mode=commander&scene=fake&ui=ar&xray=0&cam=fixed&campos=0,0,1&camat=0,0,-3&t=12` });
  await waitFor('!!window.__omni?.clockObj && !!__omni.xray && !!__omni.portal');
  await evaluate('__omni.clockObj.pause(); __omni.clockObj.seek(12)');
  await waitFor('__omni.clock >= 12');
  await new Promise((ok) => setTimeout(ok, 300));
  const previewState = () => evaluate(`({ui: document.body.dataset.ui, xray: __omni.xray, points: __omni.points, staticVisible: __omni.sceneRoot.children[0].visible,
    portal: __omni.portal, ghostVisible: !!(__omni.ghost && __omni.ghost.visible), mode: document.getElementById('ro-mode').textContent,
    legend: ${shown('legend')}, arPanel: ${shown('ar-session')}, lookSelect: ${shown('sel-look')}, exitButton: ${shown('btn-exit-ar')},
    xrayButton: document.getElementById('btn-xray').classList.contains('active'), body: getComputedStyle(document.body).backgroundColor,
    caption: document.getElementById('caption').textContent, wallClip: __omni.sceneRoot.children[0].material.uniforms.uWallClip.value, errors: __omni.errors})`);
  const cameraView = await previewState();
  assert.equal(cameraView.ui, 'ar');
  assert.deepEqual({ on: cameraView.xray.on, progress: cameraView.xray.progress }, { on: false, progress: 0 });
  assert.deepEqual([cameraView.points, cameraView.staticVisible, cameraView.ghostVisible, cameraView.portal.open], [0, false, false, 0]);
  assert.deepEqual([cameraView.mode, cameraView.legend, cameraView.arPanel, cameraView.lookSelect, cameraView.exitButton, cameraView.xrayButton], ['Camera', false, true, false, false, false]);
  assert.equal(cameraView.body, 'rgba(0, 0, 0, 0)');
  assert.match(cameraView.caption, /Replayed from a recorded walkthrough · point-based rendering/);
  assert.deepEqual(cameraView.errors, []);
  const cameraShot = await command('Page.captureScreenshot', { format: 'png' });
  await writeFile(resolve(output, 'preview-camera.png'), Buffer.from(cameraShot.data, 'base64'));
  await evaluate('__omni.setXray(true, 1)'); // the render script's frame-exact switch
  await new Promise((ok) => setTimeout(ok, 300));
  const xrayView = await previewState();
  assert.deepEqual({ on: xrayView.xray.on, progress: xrayView.xray.progress, animate: xrayView.xray.animate }, { on: true, progress: 1, animate: false });
  assert.ok(xrayView.points > 0 && xrayView.staticVisible && xrayView.ghostVisible, JSON.stringify(xrayView));
  assert.ok(xrayView.portal.enabled && xrayView.portal.open === 1 && xrayView.portal.outside && Math.abs(xrayView.portal.hit[2] - (-1.8)) < 1e-6, JSON.stringify(xrayView.portal));
  assert.deepEqual([xrayView.mode, xrayView.legend, xrayView.xrayButton, xrayView.wallClip], ['X-ray', true, true, 0.14]);
  assert.deepEqual(xrayView.errors, []);
  const xrayShot = await command('Page.captureScreenshot', { format: 'png' });
  await writeFile(resolve(output, 'preview-xray.png'), Buffer.from(xrayShot.data, 'base64'));
  await evaluate("document.getElementById('btn-xray').click()"); // the HUD toggle animates the iris shut
  await new Promise((ok) => setTimeout(ok, 120));
  const closing = await evaluate('__omni.xray');
  assert.ok(closing.on === false && closing.animate === true && closing.progress > 0 && closing.progress < 1, JSON.stringify(closing));
  await waitFor('__omni.xray.progress === 0 && __omni.points === 0');
  await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x' }))");
  await waitFor('__omni.xray.on === true && __omni.xray.progress === 1');
  // a wall that is not z = wall_z: the plane x = -3 with the camera outside it (x < -3), looking +X
  await command('Page.navigate', { url: `${base}?mode=commander&scene=fake&ui=ar&wall=-x:-3&cam=fixed&campos=-5,0.2,-3&camat=0,0.2,-3&t=20` });
  await waitFor('!!window.__omni?.portal && __omni.portal.enabled && __omni.wall');
  await new Promise((ok) => setTimeout(ok, 300));
  const wall = await evaluate(`({wall: __omni.wall, portal: __omni.portal, plane: __omni.sceneRoot.children[0].material.uniforms.uWallPlane.value.toArray(),
    clip: __omni.sceneRoot.children[0].material.uniforms.uWallClip.value, errors: __omni.errors})`);
  assert.deepEqual(wall.wall, { normal: [-1, 0, 0], d: 3, spec: '-x:-3' });
  assert.ok(Math.abs(wall.portal.hit[0] - (-3)) < 1e-6 && Math.abs(wall.portal.hit[1] - 0.2) < 1e-6 && Math.abs(wall.portal.hit[2] - (-3)) < 1e-6 && wall.portal.outside, JSON.stringify(wall.portal));
  assert.deepEqual(wall.plane, [-1, 0, 0, 3]);
  assert.equal(wall.clip, 0.14);
  assert.deepEqual(wall.errors, []);
  // Object outlines and the team map on the committed box fixture (public/scenes/box/outlines.json: two hand-annotated boxes)
  await command('Page.navigate', { url: `${base}?mode=commander&scene=box&ui=ar&cam=fixed&campos=0,0,1&camat=0,0,-3&t=20` });
  await waitFor('!!window.__omni?.clockObj && Array.isArray(__omni.outlines) && __omni.outlines.length === 2');
  await evaluate('__omni.clockObj.pause(); __omni.clockObj.seek(20)');
  await waitFor('__omni.clock >= 20');
  await new Promise((ok) => setTimeout(ok, 300));
  const sketch = await evaluate(`({outlines: __omni.outlines, count: __omni.outlineCount, nodes: __omni.sceneRoot.getObjectByName('outlines').children.map((n) => [n.name, n.visible]),
    map: ${shown('map')}, legendOutlines: ${shown('legend-outlines')}, errors: __omni.errors,
    painted: (() => { const c = document.getElementById('minimap'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; })()})`);
  assert.equal(sketch.count, 2);
  assert.ok(sketch.outlines.every((o) => o.visible && o.alpha > 0.5 && Number.isFinite(o.t)), JSON.stringify(sketch.outlines));
  assert.deepEqual(sketch.nodes, [['outline-0', true], ['outline-1', true]]);
  assert.ok(sketch.map && sketch.legendOutlines, JSON.stringify(sketch));
  assert.ok(sketch.painted > 500, `team map painted ${sketch.painted} px`);
  assert.deepEqual(sketch.errors, []);
  const sketchShot = await command('Page.captureScreenshot', { format: 'png' });
  await writeFile(resolve(output, 'sketch.png'), Buffer.from(sketchShot.data, 'base64'));
  await evaluate('__omni.setXray(false, 0)'); // the camera view hides the sketch with everything else recorded
  await new Promise((ok) => setTimeout(ok, 200));
  assert.deepEqual(await evaluate("__omni.sceneRoot.getObjectByName('outlines').children.map((n) => n.visible)"), [false, false]);
  await command('Page.navigate', { url: `${base}?mode=commander&scene=fake&ui=ar&wall=bogus` });
  await waitFor('!!window.__omni?.clockObj && __omni.errors.length > 0');
  assert.match((await evaluate('__omni.errors'))[0], /Bad \?wall=bogus/);
  errors.length = 0; // that error was the point
  // Looks: x-ray is the default; color keeps the recorded RGB; blueprint is dark-on-white and hides the outside wall.
  const looks = {};
  for (const look of ['xray', 'color', 'blueprint']) {
    await command('Page.navigate', { url: `${base}?mode=commander&scene=fake&look=${look}` });
    await waitFor('!!window.__omni?.clockObj && window.__omni.points > 0');
    await evaluate("__omni.clockObj.pause(); __omni.clockObj.seek(9); document.getElementById('hud').classList.add('hidden')");
    await waitFor('__omni.clock >= 9');
    await new Promise((ok) => setTimeout(ok, 300));
    const shot = await command('Page.captureScreenshot', { format: 'png' });
    await writeFile(resolve(output, `look-${look}.png`), Buffer.from(shot.data, 'base64'));
    await evaluate("document.getElementById('btn-topdown').click()");
    await new Promise((ok) => setTimeout(ok, 400));
    const top = await command('Page.captureScreenshot', { format: 'png' });
    await writeFile(resolve(output, `look-${look}-topdown.png`), Buffer.from(top.data, 'base64'));
    await evaluate("document.getElementById('btn-topdown').click()");
    looks[look] = await evaluate(`({look: __omni.look, bodyLook: document.body.dataset.look, sel: document.getElementById('sel-look').value,
      cutaway: __omni.cutaway, alignVisible: __omni.sceneRoot.children[1].visible, errors: __omni.errors})`);
    assert.equal(looks[look].cutaway, true);
    assert.equal(looks[look].look, look);
    assert.equal(looks[look].bodyLook, look);
    assert.equal(looks[look].sel, look);
    assert.deepEqual(looks[look].errors, []);
  }
  assert.equal(looks.xray.alignVisible, false); // cutaway hides the outside wall in commander mode
  await evaluate("document.getElementById('btn-cutaway').click()");
  await waitFor('__omni.cutaway === false');
  assert.equal(await evaluate('__omni.sceneRoot.children[1].visible'), false); // blueprint never shows it
  await command('Page.navigate', { url: `${base}?mode=commander&scene=fake&cutaway=0` });
  await waitFor('!!window.__omni?.clockObj && window.__omni.points > 0');
  assert.equal(await evaluate('__omni.cutaway'), false);
  assert.equal(await evaluate('__omni.sceneRoot.children[1].visible'), true);
  await evaluate("localStorage.setItem('omnisight.alignment.v1', JSON.stringify({x: 0.1, y: -0.2, z: 0.3, yaw: 1}))");
  await command('Page.navigate', { url: `${base}?mode=ar&scene=box` });
  await waitFor("!!window.__omni?.alignment && document.getElementById('btn-enter-ar').textContent === 'AR unavailable'");
  const ar = await evaluate(`({mode: __omni.mode, errors: __omni.errors,
    status: document.getElementById('ar-status').textContent,
    preVisible: !document.getElementById('pre').classList.contains('hidden'),
    hudHidden: document.getElementById('hud').classList.contains('hidden'),
    context: document.querySelector('canvas').getContext('webgl2').getContextAttributes()})`);
  assert.equal(ar.mode, 'ar');
  assert.ok(ar.preVisible && ar.hudHidden);
  assert.equal(ar.context.alpha, true);
  assert.equal(ar.context.antialias, false);
  assert.deepEqual(ar.errors, []);
  // Drive the real DOM controls outside XR; this does not simulate a camera session.
  assert.deepEqual(await evaluate('__omni.alignment'), { x: 0.1, y: -0.2, z: 0.3, yaw: 1 });
  assert.equal(await evaluate('__omni.sceneRoot.children[1].visible'), false);
  await evaluate(`document.getElementById('btn-align').click();
    document.getElementById('align-x-plus').click();
    document.getElementById('align-y-minus').click();
    document.getElementById('align-z-plus').click();
    document.getElementById('align-yaw-plus').click();
    document.getElementById('btn-save-alignment').click()`);
  const alignment = await evaluate(`({values: __omni.alignment, root: __omni.sceneRoot.position.toArray(),
    yaw: __omni.sceneRoot.rotation.y, cloudVisible: __omni.sceneRoot.children[1].visible,
    saved: JSON.parse(localStorage.getItem('omnisight.alignment.v1'))})`);
  assert.deepEqual(alignment.values, { x: 0.11, y: -0.21, z: 0.31, yaw: 1.5 });
  assert.deepEqual(alignment.saved, alignment.values);
  assert.deepEqual(alignment.root, [0.11, -0.21, 0.31]);
  assert.equal(alignment.yaw, 1.5 * Math.PI / 180);
  assert.equal(alignment.cloudVisible, true);
  // Layout-only screenshot: explicitly reveal the overlay; no XR hardware is claimed.
  await command('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 1, mobile: true });
  await evaluate("document.getElementById('hud').classList.remove('hidden'); document.getElementById('pre').classList.add('hidden')");
  const mobile = await command('Page.captureScreenshot', { format: 'png' });
  await writeFile(resolve(output, 'alignment-layout-only.png'), Buffer.from(mobile.data, 'base64'));
  await command('Emulation.clearDeviceMetricsOverride');
  await command('Page.navigate', { url: `${base}?mode=ar&scene=box&ax=0&ayaw=-2` });
  await waitFor('!!window.__omni?.alignment');
  assert.deepEqual(await evaluate('__omni.alignment'), { x: 0, y: -0.21, z: 0.31, yaw: -2 });
  assert.equal(await evaluate("JSON.parse(localStorage.getItem('omnisight.alignment.v1')).x"), 0.11);
  await evaluate("document.getElementById('btn-align').click(); document.getElementById('btn-align').click()");
  assert.equal(await evaluate('__omni.sceneRoot.children[1].visible'), false);
  await evaluate("document.getElementById('btn-reset-alignment').click()");
  assert.deepEqual(await evaluate('__omni.alignment'), { x: 0, y: 0, z: 0, yaw: 0 });
  await command('Page.navigate', { url: `${base}?mode=ar&scene=box` });
  await waitFor('!!window.__omni?.alignment');
  assert.deepEqual(await evaluate('__omni.alignment'), { x: 0, y: 0, z: 0, yaw: 0 });
  await evaluate("localStorage.setItem('omnisight.alignment.v1', 'broken JSON')");
  await command('Page.navigate', { url: `${base}?mode=ar&scene=box` });
  await waitFor('!!window.__omni?.alignment');
  assert.deepEqual(await evaluate('__omni.alignment'), { x: 0, y: 0, z: 0, yaw: 0 });
  assert.match(await evaluate("document.getElementById('alignment-status').textContent"), /could not be read/);
  await evaluate("localStorage.setItem('omnisight.alignment.v1', JSON.stringify({x: 1, yaw: 20}))");
  // Draw caps on the gitignored stress scene (`npm run stress`); it is never deployed, so skip it when the manifest is absent.
  const stressManifest = await fetch(`${base}scenes/stress/manifest.json`).then((r) => r.ok, () => false);
  if (!stressManifest) console.warn(`[smoke] no stress scene at ${base}scenes/stress/, skipping the budget caps`);
  const budgets = [];
  for (const budget of stressManifest ? [200000, 400000, 800000, 0] : []) {
    await command('Page.navigate', { url: `${base}?mode=commander&scene=stress&budget=${budget}&bench=1&ax=1&ayaw=20&cutaway=0` });
    await waitFor('!!window.__omni?.clockObj && __omni.clock === __omni.data.duration && __omni.points > 0');
    const counts = await evaluate(`({budget: __omni.budget, total: __omni.data.static.count,
      staticDrawn: __omni.points - __omni.data.alignment.count, playing: __omni.clockObj.playing, errors: __omni.errors})`);
    assert.equal(counts.staticDrawn, budget ? Math.min(budget, counts.total) : counts.total);
    assert.equal(counts.playing, false);
    assert.deepEqual(counts.errors, []);
    assert.deepEqual(await evaluate('__omni.sceneRoot.position.toArray()'), [0, 0, 0]);
    assert.equal(await evaluate('__omni.sceneRoot.rotation.y'), 0); // commander ignores AR offsets
    budgets.push(counts);
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ base, commander, ghost: { seen, fading }, responder, two, capture, portal, looks, ar, alignment, budgets, output }, null, 2));
  await send('Browser.close');
} finally {
  ws?.close();
  browser.kill();
}
