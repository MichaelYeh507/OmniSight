// Headless load of one scene folder in commander mode: reports what the viewer saw and saves a screenshot.
// B5 acceptance for a scene from A or C: validate-scene.mjs exit 0, then this exits 0 with no errors.
//   node scripts/load-scene.mjs <scene>            scene folder name under public/scenes (dev server running)
//   node scripts/load-scene.mjs <scene> --t 12     seek to 12 s before reporting (default: the end of the replay)
//   node scripts/load-scene.mjs <scene> --params "renderer=spark&look=color"   extra URL parameters
//   OMNI_URL=<base> for another server; OMNI_CHROME=<exe> if Chrome/Edge is not in the default place.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const scene = args.find((a) => !a.startsWith('--'));
if (!scene) throw new Error('usage: node scripts/load-scene.mjs <scene> [--t seconds]');
const tIndex = args.indexOf('--t');
const seekTo = tIndex >= 0 ? Number(args[tIndex + 1]) : null;
const evalIndex = args.indexOf('--eval');
const evalExpr = evalIndex >= 0 ? args[evalIndex + 1] : null; // extra expression evaluated in the page, reported as `eval`
const paramsIndex = args.indexOf('--params');
const extra = paramsIndex >= 0 && args[paramsIndex + 1] ? `&${args[paramsIndex + 1].replace(/^[?&]/, '')}` : '';
const executable = process.env.OMNI_CHROME || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);
if (!executable) throw new Error('Set OMNI_CHROME to a Chrome/Chromium executable.');
const base = (process.env.OMNI_URL || 'http://127.0.0.1:5173/OmniSight/').replace(/\/?$/, '/');
const output = resolve('node_modules/.cache/omni-load');
await mkdir(output, { recursive: true });
const browser = spawn(executable, [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
  `--user-data-dir=${output}/profile`, '--window-size=1280,900', 'about:blank',
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let ws;
let code = 1;
try {
  const endpoint = await new Promise((ok, fail) => {
    let stderr = '';
    const timeout = setTimeout(() => fail(new Error('Chrome did not expose DevTools within 20 s')), 20000);
    browser.on('error', fail);
    browser.on('exit', (c) => fail(new Error(`Chrome exited ${c}: ${stderr}`)));
    browser.stderr.on('data', (d) => {
      stderr += d;
      const m = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (m) { clearTimeout(timeout); ok(m[1]); }
    });
  });
  ws = new WebSocket(endpoint);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
  let serial = 0;
  const pending = new Map();
  const consoleErrors = [];
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (m.id) { const t = pending.get(m.id); pending.delete(m.id); m.error ? t.reject(new Error(JSON.stringify(m.error))) : t.resolve(m.result); }
    else if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(m.params.exceptionDetails.text || m.params.exceptionDetails.exception?.description);
    else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const id = ++serial; pending.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params, sessionId })); });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const command = (method, params) => send(method, params, sessionId);
  await command('Runtime.enable');
  await command('Page.enable');
  const evaluate = async (expression) => {
    const r = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const waitFor = async (expression, ms = 30000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { if (await evaluate(expression)) return; await new Promise((ok) => setTimeout(ok, 100)); }
    throw new Error(`Timed out: ${expression}`);
  };
  await command('Page.navigate', { url: `${base}?mode=commander&scene=${scene}${extra}` });
  await waitFor("!!window.__omni && (window.__omni.errors.length > 0 || (window.__omni.clockObj && window.__omni.points > 0))");
  if (await evaluate('window.__omni.clockObj ? true : false')) {
    await evaluate(`__omni.clockObj.pause(); __omni.clockObj.seek(${seekTo ?? '__omni.data.duration'})`);
    await waitFor(`Math.abs(__omni.clock - (${seekTo ?? '__omni.data.duration'})) < 1e-6`);
    await new Promise((ok) => setTimeout(ok, 500));
  }
  const report = await evaluate(`({scene: __omni.scene, renderer: __omni.renderer || 'points', errors: __omni.errors, clock: __omni.clock,
    duration: __omni.data?.duration, staticPoints: __omni.data?.static.count, chunks: __omni.data?.manifest.chunks.length,
    alignmentPoints: __omni.data?.alignment?.count ?? 0, wallZ: __omni.data?.wallZ, floorY: __omni.data?.manifest.floor_y,
    trajectory: __omni.data?.trajectory.length, ghostFrames: __omni.ghostFrames, drawnPoints: __omni.points,
    ghost: __omni.ghost, responder: __omni.responder && {index: __omni.responder.index, position: __omni.responder.position},
    status: document.getElementById('status')?.textContent, banner: document.getElementById('error-banner')?.textContent})`);
  let evalResult;
  if (evalExpr) { // runs before the screenshot so an experiment (changing a uniform, say) shows in the picture
    evalResult = await evaluate(evalExpr);
    await evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
  }
  const shot = await command('Page.captureScreenshot', { format: 'png' });
  const file = resolve(output, `${scene}${extra ? '-' + extra.slice(1).replace(/[^a-z0-9]+/gi, '_') : ''}.png`);
  await writeFile(file, Buffer.from(shot.data, 'base64'));
  if (evalExpr) report.eval = evalResult;
  report.consoleErrors = consoleErrors;
  report.screenshot = file;
  console.log(JSON.stringify(report, null, 2));
  code = report.errors.length === 0 && consoleErrors.length === 0 && report.drawnPoints > 0 ? 0 : 1;
  await send('Browser.close');
} finally {
  ws?.close();
  browser.kill();
}
process.exit(code);
