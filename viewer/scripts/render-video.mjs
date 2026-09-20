// Renders a scene replay to an mp4, frame by frame, from headless Chrome. Deterministic: the clock is seeked per
// frame, never free-running, so the result is a clean take for the demo video. Needs the dev server (npm run dev)
// and ffmpeg on PATH. By default the page is the phone-screen preview (?ui=ar): the AR HUD over a transparent page,
// so real footage can sit behind it exactly where the camera feed sits on the phone.
//   npm run render -- room012_masked                       first person on the responder path, 1920x1080, 30 fps, whole take
//   npm run render -- room012_masked --params "cam=fixed&campos=-2.6,0,-1.4&camat=1.2,-0.5,-1.4&wall=-x:-0.69" --xray-at 7
//                                                          corridor viewpoint: camera view until 7 s, then the portal opens on the door wall
//   --bg <clip.mp4> [--bg-offset s] [--bg-stretch f] [--bg-end s]   footage behind the page (seeked per frame; render t maps to offset + t / stretch,
//                                                          held at its first frame before the clip and at --bg-end (default: its last frame) after)
//   --wheel-at "12:natural;30:xray"                        the radial view selector opens at t, picks the view, closes (1.55 s)
//   --stills 5,7,7.2,9 [--frames dir]                      only those replay times, as PNGs, no mp4: quick look before a full render
//   --dpr 2 (default)  CSS pixels are half the output pixels, the phone's own scaling: HUD text at 1080p is 2x its CSS size
//   --width 1920 --height 1080 --fps 30 --from s --to s --fov deg --xray-fade 0.45 --capture (caption only) --ui none (commander HUD)
//   --out <file.mp4> (default node_modules/.cache/omni-render/<scene>.mp4)   --frames <dir> also keeps the PNGs
import { spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve } from 'node:path';

const args = process.argv.slice(2);
const BOOLEAN_FLAGS = ['--capture'];
const scene = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && !BOOLEAN_FLAGS.includes(args[i - 1])));
if (!scene) throw new Error('usage: node scripts/render-video.mjs <scene> [--from s] [--to s] [--fps n] [--width px] [--height px] [--dpr n] [--fov deg] [--params "..."] [--xray-at s] [--bg clip] [--stills t,t] [--out file.mp4] [--frames dir]');
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);
const fps = Number(flag('fps', '30'));
const width = Number(flag('width', '1920'));
const height = Number(flag('height', '1080'));
const dpr = Number(flag('dpr', '2'));
if (!Number.isInteger(width / dpr) || !Number.isInteger(height / dpr)) throw new Error(`--dpr ${dpr} must divide ${width}x${height}`);
const from = Number(flag('from', '0'));
const to = flag('to', null) === null ? null : Number(flag('to'));
const fov = flag('fov', null);
const extra = flag('params', 'cam=follow');
const xrayAt = flag('xray-at', null) === null ? null : Number(flag('xray-at'));
const xrayFade = Number(flag('xray-fade', '0.45'));
// --wheel-at "12:natural;30:xray": the radial selector opens at t, its mark sweeps to the view, the view switches, the ring closes
const wheelEvents = (flag('wheel-at', '') || '').split(';').map((s) => s.trim()).filter(Boolean).map((s) => { const [t, view] = s.split(':'); return { t: Number(t), view }; }).filter((e) => Number.isFinite(e.t) && e.view);
const WHEEL_OPEN = 0.35, WHEEL_HOLD = 0.9, WHEEL_CLOSE = 0.3; // seconds
const ui = flag('ui', 'ar');
const capture = has('capture');
const bg = flag('bg', null);
const bgOffset = Number(flag('bg-offset', '0'));
const bgStretch = Number(flag('bg-stretch', '1'));
const bgEnd = flag('bg-end', null) === null ? null : Number(flag('bg-end')); // hold the footage at this clip time from then on (default: its last frame)
const stills = flag('stills', null) === null ? null : flag('stills').split(',').map(Number).filter(Number.isFinite);
const framesDir = flag('frames', null);
const cache = resolve('node_modules/.cache/omni-render');
await mkdir(cache, { recursive: true });
const out = resolve(flag('out', resolve(cache, `${scene}.mp4`)));
const stillsDir = resolve(framesDir || resolve(cache, `${scene}-stills`));
const profile = await mkdtemp(resolve(cache, 'profile-')); // one profile per run, so renders can overlap
if (framesDir || stills) await mkdir(stillsDir, { recursive: true });

const executable = process.env.OMNI_CHROME || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);
if (!executable) throw new Error('Set OMNI_CHROME to a Chrome/Chromium executable.');
const base = (process.env.OMNI_URL || 'http://127.0.0.1:5173/OmniSight/').replace(/\/?$/, '/');
const query = [`mode=commander`, `scene=${scene}`, ui === 'ar' ? 'ui=ar' : '', capture ? 'capture=1' : '', xrayAt !== null ? 'xray=0' : '',
  extra.replace(/^[?&]/, ''), fov ? `fov=${fov}` : ''].filter(Boolean).join('&');
const url = `${base}?${query}`;

/** Serve one local file with HTTP range support (Chrome needs ranges to seek a <video>). */
async function serveFile(file) {
  const size = (await stat(file)).size;
  const type = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.m4v': 'video/mp4' }[extname(file).toLowerCase()] || 'application/octet-stream';
  const server = createServer((req, res) => {
    let start = 0;
    let end = size - 1;
    const m = (req.headers.range || '').match(/bytes=(\d*)-(\d*)/);
    if (m) {
      if (m[1]) start = Number(m[1]);
      if (m[2]) end = m[1] ? Number(m[2]) : size - 1;
      if (!m[1] && m[2]) start = size - Number(m[2]);
    }
    end = Math.min(end, size - 1);
    res.writeHead(m ? 206 : 200, {
      'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'no-store',
      ...(m ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file, { start, end }).pipe(res);
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return { url: `http://127.0.0.1:${server.address().port}/clip${extname(file)}`, close: () => server.close() };
}

const browser = spawn(executable, [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required',
  `--user-data-dir=${profile}`, `--window-size=${width},${height}`, 'about:blank',
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let ws;
let ffmpeg;
let bgServer = null;
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
  const errors = [];
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (m.id) {
      const t = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) t.reject(new Error(JSON.stringify(m.error)));
      else t.resolve(m.result);
    } else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text);
  };
  const CDP_TIMEOUT = 45000; // a frame never takes this long; a page that reloaded mid-render (src/ edit, a file written into viewer/public) hangs otherwise
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const id = ++serial;
    const timer = setTimeout(() => {
      pending.delete(id);
      rej(new Error(`DevTools ${method} did not answer within ${CDP_TIMEOUT / 1000} s. If the dev server reloaded the page (editing src/ or index.html, or writing into viewer/public, e.g. the pipeline) the render cannot continue: rerun it.`));
    }, CDP_TIMEOUT);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); res(v); }, reject: (e) => { clearTimeout(timer); rej(e); } });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  ws.onclose = () => {
    for (const t of pending.values()) t.reject(new Error('DevTools socket closed'));
    pending.clear();
  };
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const command = (method, params) => send(method, params, sessionId);
  await command('Runtime.enable');
  await command('Page.enable');
  // the phone's own scaling: lay the HUD out in CSS pixels at width/dpr and rasterise at dpr, so text has the same share of the frame
  await command('Emulation.setDeviceMetricsOverride', { width: width / dpr, height: height / dpr, deviceScaleFactor: dpr, mobile: false });
  const evaluate = async (expression) => {
    const r = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  await command('Page.navigate', { url });
  if (!bg) await command('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 255 } }); // a transparent page over black, not the screenshot's white
  const deadline = Date.now() + 60000;
  while (!(await evaluate('!!window.__omni?.clockObj && window.__omni.data && (window.__omni.points > 0 || window.__omni.xray?.progress === 0)'))) {
    if (Date.now() > deadline) throw new Error('scene did not load within 60 s');
    await new Promise((ok) => setTimeout(ok, 100));
  }
  let backdrop = null;
  if (bg) {
    // footage behind the page, exactly where the camera feed sits on the phone; the body is transparent in ?ui=ar
    bgServer = await serveFile(resolve(bg));
    backdrop = await evaluate(`(async () => {
      const v = document.createElement('video');
      v.id = 'omni-bg'; v.muted = true; v.playsInline = true; v.preload = 'auto';
      v.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;object-fit:cover;z-index:-1;background:#000';
      v.src = ${JSON.stringify(bgServer.url)};
      document.body.prepend(v);
      await new Promise((ok, fail) => { v.addEventListener('loadeddata', ok, { once: true }); v.addEventListener('error', () => fail(new Error('backdrop video failed to load: ' + (v.error && v.error.message))), { once: true }); });
      return { width: v.videoWidth, height: v.videoHeight, duration: v.duration };
    })()`);
    console.error(`[render] backdrop ${bg}: ${backdrop.width}x${backdrop.height}, ${backdrop.duration.toFixed(2)} s, offset ${bgOffset} s, stretch x${bgStretch}`);
  }
  const duration = await evaluate('__omni.data.duration');
  const end = to === null ? duration : Math.min(to, duration);
  const frames = stills ? stills.length : Math.max(1, Math.round((end - from) * fps));
  console.error(`[render] ${url}`);
  console.error(stills ? `[render] stills at ${stills.join(', ')} s -> ${stillsDir}` : `[render] ${width}x${height} @ ${fps} fps (dpr ${dpr}), ${from}-${end.toFixed(2)} s, ${frames} frames -> ${out}`);
  if (xrayAt !== null) console.error(`[render] camera view until ${xrayAt} s, then x-ray (iris ${xrayFade} s)`);
  await evaluate('__omni.clockObj.pause()');
  // seek the footage and the replay clock to t, set the scripted x-ray state, then let two animation frames run so the canvas shows it
  const frameAt = async (t) => {
    const xray = xrayAt === null ? '' : (() => {
      const p = Math.min(1, Math.max(0, xrayFade > 0 ? (t - xrayAt) / xrayFade : t >= xrayAt ? 1 : 0));
      return `__omni.setXray(${p > 0}, ${p});`;
    })();
    // wheel events: before an event the view is whatever the previous event set (or the URL's); the view switches when the mark lands
    let wheelJs = '';
    if (wheelEvents.length) {
      let view = null;
      let anim = null;
      for (const e of wheelEvents) {
        const dt = t - e.t;
        if (dt < 0) break;
        if (dt < WHEEL_OPEN) anim = { progress: dt / WHEEL_OPEN, hover: null };
        else if (dt < WHEEL_OPEN + WHEEL_HOLD) { anim = { progress: 1, hover: e.view }; if (dt > WHEEL_OPEN + WHEEL_HOLD * 0.55) view = e.view; }
        else if (dt < WHEEL_OPEN + WHEEL_HOLD + WHEEL_CLOSE) { anim = { progress: 1 - (dt - WHEEL_OPEN - WHEEL_HOLD) / WHEEL_CLOSE, hover: e.view }; view = e.view; }
        else { anim = null; view = e.view; }
      }
      wheelJs = `${view ? `if (__omni.view !== ${JSON.stringify(view)}) __omni.setView(${JSON.stringify(view)}, 1);` : ''} if (__omni.wheel) __omni.wheel.showAt(${JSON.stringify(anim)});`;
    }
    const seekBg = bg ? `const v = document.getElementById('omni-bg'); const bt = Math.min(${bgEnd === null ? 'v.duration - 0.05' : bgEnd}, Math.max(0, ${bgOffset} + ${t} / ${bgStretch})); // before the clip: its first frame; after: its last (seeking past the end shows frame 0)
      if (Math.abs(v.currentTime - bt) > 1e-4) await new Promise((ok) => { v.addEventListener('seeked', ok, { once: true }); v.currentTime = bt; });` : '';
    try {
      await evaluate(`(async () => { ${seekBg} ${xray} ${wheelJs} __omni.clockObj.seek(${t}); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); })()`);
    } catch (e) {
      const alive = await evaluate('!!(window.__omni && window.__omni.clockObj)').catch(() => false);
      throw alive ? e : new Error(`the page reloaded during the render at t=${t.toFixed(2)} s (the dev server reloads every page when src/, index.html or a file under viewer/public changes): ${e.message}`);
    }
    const shot = await command('Page.captureScreenshot', { format: 'png' });
    const png = Buffer.from(shot.data, 'base64');
    const w = png.readUInt32BE(16);
    const h = png.readUInt32BE(20);
    if (w !== width || h !== height) throw new Error(`screenshot is ${w}x${h}, expected ${width}x${height}`);
    return png;
  };
  if (stills) {
    const files = [];
    for (const t of stills) {
      const png = await frameAt(t);
      const file = resolve(stillsDir, `${scene}-${t.toFixed(2).replace(/\.?0+$/, '')}s.png`);
      await writeFile(file, png);
      files.push(file);
      console.error(`[render] still t=${t} s -> ${file}`);
    }
    const state = await evaluate('({cam: __omni.cam, wall: __omni.wall, xray: __omni.xray, portal: __omni.portal, ghost: __omni.ghost, errors: __omni.errors})');
    console.log(JSON.stringify({ scene, url, stills: files, width, height, dpr, backdrop, ...state, errors: [...state.errors, ...errors] }, null, 2));
  } else {
    ffmpeg = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-movflags', '+faststart', out],
    { windowsHide: true, stdio: ['pipe', 'inherit', 'inherit'] });
    const started = Date.now();
    for (let i = 0; i < frames; i++) {
      const t = from + i / fps;
      const png = await frameAt(t);
      if (framesDir) await writeFile(resolve(framesDir, `${String(i).padStart(5, '0')}.png`), png);
      if (!ffmpeg.stdin.write(png)) await new Promise((ok) => ffmpeg.stdin.once('drain', ok));
      if (i % (fps * 5) === 0) console.error(`[render] ${i}/${frames} (t=${t.toFixed(1)} s, ${((Date.now() - started) / 1000).toFixed(0)} s elapsed)`);
    }
    ffmpeg.stdin.end();
    await new Promise((ok, fail) => ffmpeg.on('exit', (c) => (c === 0 ? ok() : fail(new Error(`ffmpeg exited ${c}`)))));
    ffmpeg = null;
    const state = await evaluate('({cam: __omni.cam, wall: __omni.wall, renderer: __omni.renderer || "points", errors: __omni.errors})');
    console.log(JSON.stringify({ scene, url, out, frames, fps, width, height, dpr, from, to: end, xrayAt, backdrop, cam: state.cam, wall: state.wall, renderer: state.renderer, errors: [...state.errors, ...errors] }, null, 2));
  }
  await send('Browser.close');
} finally {
  ws?.close();
  ffmpeg?.kill();
  bgServer?.close();
  browser.kill();
  setTimeout(() => rm(profile, { recursive: true, force: true }).catch(() => {}), 500);
}
