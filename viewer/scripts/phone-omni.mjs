// Reads window.__omni from the OmniSight tab in Chrome on the USB-connected Samsung, without chrome://inspect.
//   npm run phone                               snapshot: benchmark, XR framebuffer, tracking, resets, errors, points, clock
//   npm run phone -- --expr "__omni.alignment"  evaluate any expression in that tab
//   npm run phone -- --tab stress               choose the tab whose URL contains this text, or a DevTools tab id (default: prefers mode=ar)
//   npm run phone -- --serial R5CR...           when two phones are attached
//   npm run phone -- --watch 5 --for 10         heat soak: one line every 5 s for 10 minutes (fps, tracking, points, benchmark)
// Prints a ready SAMSUNG.md table row when a "Measure 10 s" result exists. adb: OMNI_ADB, PATH, or the Android SDK default.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const sdkAdb = `${process.env.LOCALAPPDATA || ''}/Android/Sdk/platform-tools/adb.exe`;
const adb = process.env.OMNI_ADB || (existsSync(sdkAdb) ? sdkAdb : 'adb');
const port = Number(flag('port', '9222'));
const watchEvery = Number(flag('watch', '0'));
const watchMinutes = Number(flag('for', '10'));
const run = (...adbArgs) => execFileSync(adb, adbArgs, { encoding: 'utf8', windowsHide: true }).trim();

const devices = run('devices', '-l').split('\n').slice(1).map((line) => line.trim().split(/\s+/)).filter((f) => f.length > 1);
const ready = devices.filter((f) => f[1] === 'device').map((f) => f[0]);
if (ready.length === 0) {
  const states = devices.map((f) => `${f[0]} (${f[1]})`).join(', ') || 'none';
  console.error(`No authorized phone over USB. adb sees: ${states}. Enable USB debugging, accept the RSA prompt, then retry.`);
  process.exit(1);
}
const serial = flag('serial', ready.length === 1 ? ready[0] : null);
if (!serial || !ready.includes(serial)) {
  console.error(`Choose one phone with --serial: ${ready.join(', ')}`);
  process.exit(1);
}
const target = (...adbArgs) => run('-s', serial, ...adbArgs);
target('forward', `tcp:${port}`, 'localabstract:chrome_devtools_remote');
let ws;
try {
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
  const tabs = (await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()))
    .filter((tab) => tab.type === 'page' && tab.url.includes('/OmniSight/'));
  const wanted = flag('tab', null);
  const tab = tabs.find((t) => (wanted ? t.id === wanted || t.url.includes(wanted) : t.url.includes('mode=ar'))) || tabs[0];
  if (!tab) {
    console.error(`No OmniSight tab open in Chrome on ${serial}. Open the viewer URL on the phone first.`);
    process.exit(1);
  }
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = () => fail(new Error('DevTools socket refused; is the tab still open?')); });
  let serialId = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const reply = JSON.parse(data);
    const task = pending.get(reply.id);
    if (!task) return;
    pending.delete(reply.id);
    if (reply.error || reply.result.exceptionDetails) task.reject(new Error(JSON.stringify(reply.error || reply.result.exceptionDetails)));
    else task.resolve(reply.result.result.value);
  };
  const evaluate = (expression) => new Promise((resolve, reject) => {
    const id = ++serialId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
  });
  const parse = (value) => { try { return JSON.parse(value); } catch { return value; } };
  const model = target('shell', 'getprop', 'ro.product.model');
  const chrome = (version.Browser || '').replace(/^Chrome\//, '');

  if (watchEvery > 0) {
    // heat soak / long-session log: one compact line per tick until --for minutes pass or the tab goes away
    const expression = `JSON.stringify({t: Math.round(__omni.clock * 10) / 10, xr: __omni.xrPresenting, tracking: __omni.tracking, fps: __omni.fps,
      points: __omni.points, resets: __omni.resets, errors: __omni.errors.length, aligning: !!__omni.aligning,
      bench: __omni.benchmark && [Math.round(__omni.benchmark.fps * 100) / 100, Math.round(__omni.benchmark.minFps * 100) / 100]})`;
    console.log(`# ${model} / Chrome ${chrome} / ${tab.url}\n# time  clock  xr  tracking  fps  points  resets  errors  benchmark(avg,min)`);
    const until = Date.now() + watchMinutes * 60000;
    let lastBench = null;
    while (Date.now() < until) {
      const v = parse(await evaluate(expression));
      const bench = v.bench ? `${v.bench[0]}/${v.bench[1]}` : '-';
      const flagNew = v.bench && JSON.stringify(v.bench) !== lastBench ? '  <- new measurement' : '';
      lastBench = v.bench ? JSON.stringify(v.bench) : lastBench;
      console.log(`${new Date().toTimeString().slice(0, 8)}  ${String(v.t).padStart(5)}  ${v.xr ? 'AR ' : 'off'}  ${v.tracking ? 'ok  ' : 'lost'}  ${String(v.fps).padStart(3)}  ${String(v.points).padStart(7)}  ${v.resets}  ${v.errors}  ${bench}${flagNew}${v.aligning ? '  aligning' : ''}`);
      await new Promise((ok) => setTimeout(ok, watchEvery * 1000));
    }
    process.exit(0);
  }

  const expression = flag('expr', `JSON.stringify({url: location.href, scene: __omni.scene, mode: __omni.mode, budget: __omni.budget,
    points: __omni.points, clock: __omni.clock, fps: __omni.fps, xrPresenting: __omni.xrPresenting, tracking: __omni.tracking,
    resets: __omni.resets, xrFramebuffer: __omni.xrFramebuffer, fbscale: __omni.fbscale, look: __omni.look, aligning: __omni.aligning,
    alignment: __omni.alignment, ghost: __omni.ghost, portal: __omni.portal, responders: __omni.responders, benchmark: __omni.benchmark, errors: __omni.errors})`);
  const value = parse(await evaluate(expression));
  console.log(JSON.stringify({ serial, model, chrome, tab: tab.url, value }, null, 2));
  const b = value && value.benchmark;
  if (b) {
    const fb = b.xrFramebuffer ? `${b.xrFramebuffer.width} x ${b.xrFramebuffer.height}` : 'n/a';
    console.log('\nSAMSUNG.md row:');
    console.log(`| ${model} / ${chrome} | ${b.budget.toLocaleString()} | ${b.points.toLocaleString()} | ${fb} | ${b.fbscale} | ${b.fps.toFixed(2)} | ${b.minFps.toFixed(2)} | ${b.frames} XR frames / ${b.seconds.toFixed(3)} s; x-ray, zero URL offsets; resets ${b.resets}, errors ${(value.errors || []).length} |`);
  }
} finally {
  ws?.close();
  target('forward', '--remove', `tcp:${port}`);
}
