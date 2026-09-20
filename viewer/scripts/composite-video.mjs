// Demo composite: real outside-wall footage on top of the first-person 3D render. The footage stays opaque while the
// responder is outside, then fades to transparent around the moment the recorded path crosses the wall plane, so the
// viewer "sees through the wall" into the reconstructed room. Pure ffmpeg; needs it on PATH.
//   node scripts/composite-video.mjs --render <3d.mp4> --outside <wall.mp4> --cross 28.7 [--fade 2] [--offset 0] [--floor 0] [--out demo.mp4]
//   --cross   render-time (s) at which the path crosses the wall (from trajectory.json: first pose with z < wall_z)
//   --fade    seconds the footage takes to go transparent, centred on --cross (default 2)
//   --offset  seconds into the outside footage that line up with render t = 0 (default 0; the take's own rgb.mp4 is 0)
//   --floor   opacity the footage keeps after the fade, 0..1 (default 0: fully see-through)
//   --stretch time-stretch factor for the footage so its clock matches the recording clock (Stray Scanner 012: 1.00411 =
//             odometry span / (frames / 60)); the render already runs on the recording clock
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const render = flag('render', null);
const outside = flag('outside', null);
const cross = Number(flag('cross', NaN));
if (!render || !outside || !Number.isFinite(cross)) throw new Error('usage: --render <3d.mp4> --outside <wall.mp4> --cross <seconds> [--fade s] [--offset s] [--floor 0..1] [--out file]');
const fade = Number(flag('fade', '2'));
const offset = Number(flag('offset', '0'));
const floor = Math.min(1, Math.max(0, Number(flag('floor', '0'))));
const stretch = Number(flag('stretch', '1'));
const out = resolve(flag('out', resolve('node_modules/.cache/omni-render/demo-composite.mp4')));

const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'csv=p=0', render], { encoding: 'utf8', windowsHide: true });
if (probe.status !== 0) throw new Error(`ffprobe failed on ${render}: ${probe.stderr}`);
const [w, h, rate] = probe.stdout.trim().split(',');
const width = Number(w);
const height = Number(h);
const fps = rate.includes('/') ? Number(rate.split('/')[0]) / Number(rate.split('/')[1]) : Number(rate);
const start = Math.max(0, cross - fade / 2);
// The footage is scaled and centre-cropped to the render size. Two copies sit on the render: one fading to fully
// transparent over `fade` seconds (ffmpeg's alpha fade, fast), and, when --floor > 0, one held at that constant opacity
// underneath it so the wall never disappears completely.
const prep = `setpts=(PTS-STARTPTS)*${stretch},fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},format=yuva420p`;
const chains = [`[0:v]setpts=PTS-STARTPTS[room]`, `[1:v]${prep},split=2[wa][wb]`];
chains.push(`[wa]fade=t=out:st=${start}:d=${fade}:alpha=1[wall]`);
if (floor > 0) {
  chains.push(`[wb]colorchannelmixer=aa=${floor}[wallfloor]`, `[room][wallfloor]overlay=0:0:shortest=1:format=auto[roomfloor]`, `[roomfloor][wall]overlay=0:0:shortest=1:format=auto,format=yuv420p[v]`);
} else {
  chains.push(`[wb]nullsink`, `[room][wall]overlay=0:0:shortest=1:format=auto,format=yuv420p[v]`);
}
const filter = chains.join(';');
const cmd = ['-y', '-loglevel', 'error', '-i', render, '-ss', String(offset), '-i', outside,
  '-filter_complex', filter, '-map', '[v]', '-map', '1:a?', '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', out];
console.error(`[composite] ${width}x${height} @ ${fps} fps, footage stretched x${stretch}; footage opaque until ${start.toFixed(2)} s, transparent (${floor}) by ${(start + fade).toFixed(2)} s; offset ${offset} s\nffmpeg ${cmd.join(' ')}`);
const run = spawnSync('ffmpeg', cmd, { stdio: 'inherit', windowsHide: true });
if (run.status !== 0) process.exit(run.status ?? 1);
console.log(out);
