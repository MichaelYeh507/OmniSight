// Cuts the demo video together from rendered shots: title cards, trimmed clips and short crossfades, one ffmpeg run.
//   node scripts/assemble-demo.mjs --out demo.mp4 \
//     --title "OmniSight|Through-wall awareness from one walkthrough" \
//     --clip node_modules/.cache/omni-render/room012_follow_ui.mp4:0:20 \
//     --title "What the second responder sees" \
//     --clip node_modules/.cache/omni-render/demo-corridor.mp4:2:40
//   --clip <file>[:from[:to]]   a shot, optionally trimmed (seconds)
//   --title "Line 1|Line 2"     a 2.5 s card (dark, cyan rule, system font); --card-seconds changes the length
//   --fade 0.5                  crossfade between every pair of segments (0 for hard cuts)
//   --width 1920 --height 1080 --fps 30   every segment is scaled and padded to this
// Needs ffmpeg with libx264 and drawtext (the winget build has both). Segments keep no audio: the voiceover is added later.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const out = resolve(flag('out', 'node_modules/.cache/omni-render/demo.mp4'));
const width = Number(flag('width', '1920'));
const height = Number(flag('height', '1080'));
const fps = Number(flag('fps', '30'));
const fade = Number(flag('fade', '0.5'));
const cardSeconds = Number(flag('card-seconds', '2.5'));
const fontFile = flag('font', ['C:/Windows/Fonts/segoeuib.ttf', 'C:/Windows/Fonts/arialbd.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'].find(existsSync) || '');
const segments = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--clip') {
    // <path>[:from[:to]]; a Windows drive letter is a single-letter part, never a trim value
    const parts = args[++i].split(':');
    let f = null;
    let t = null;
    if (parts.length >= 3 && /^[\d.]*$/.test(parts.at(-1)) && /^[\d.]*$/.test(parts.at(-2)) && !/^[a-zA-Z]$/.test(parts.at(-3))) { t = parts.pop(); f = parts.pop(); }
    else if (parts.length >= 2 && /^[\d.]+$/.test(parts.at(-1)) && !/^[a-zA-Z]$/.test(parts.at(-2))) f = parts.pop();
    segments.push({ kind: 'clip', path: resolve(parts.join(':')), from: f ? Number(f) : 0, to: t ? Number(t) : null });
  } else if (args[i] === '--title') segments.push({ kind: 'title', lines: args[++i].split('|') });
}
if (!segments.length) throw new Error('give at least one --clip or --title');
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\\\\\'").replace(/%/g, '\\%');

// probe clip durations so the crossfade offsets are exact
const probe = (file) => {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`ffprobe failed on ${file}: ${r.stderr}`);
  return Number(r.stdout.trim());
};
const inputs = [];
const chains = [];
const durations = [];
segments.forEach((seg, i) => {
  if (seg.kind === 'clip') {
    const total = probe(seg.path);
    const end = seg.to === null ? total : Math.min(seg.to, total);
    durations.push(end - seg.from);
    inputs.push('-ss', String(seg.from), '-t', String(end - seg.from), '-i', seg.path);
    chains.push(`[${inputs.filter((a) => a === '-i').length - 1}:v]fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=#0b0f14,setsar=1,format=yuv420p,setpts=PTS-STARTPTS[s${i}]`);
  } else {
    durations.push(cardSeconds);
    inputs.push('-f', 'lavfi', '-t', String(cardSeconds), '-i', `color=c=#0b0f14:s=${width}x${height}:r=${fps}`);
    const idx = inputs.filter((a) => a === '-i').length - 1;
    const font = fontFile ? `fontfile='${esc(fontFile)}':` : '';
    const rule = `drawbox=x=${Math.round(width * 0.1)}:y=${Math.round(height * 0.5) - 2}:w=${Math.round(width * 0.08)}:h=4:color=#4dd9ff@1:t=fill`;
    const text = seg.lines.map((line, k) => `drawtext=${font}text='${esc(line)}':fontsize=${k === 0 ? Math.round(height * 0.075) : Math.round(height * 0.04)}:fontcolor=${k === 0 ? '#e8f4f8' : '#9fb3bf'}:x=${Math.round(width * 0.1)}:y=${Math.round(height * 0.5) + (k === 0 ? -Math.round(height * 0.12) : 20 + (k - 1) * Math.round(height * 0.06))}`).join(',');
    chains.push(`[${idx}:v]${rule},${text},format=yuv420p,setpts=PTS-STARTPTS[s${i}]`);
  }
});
// crossfade chain: [s0][s1]xfade -> [x1], [x1][s2]xfade -> [x2] ...
let last = 's0';
let offset = durations[0];
for (let i = 1; i < segments.length; i++) {
  const label = i === segments.length - 1 ? 'v' : `x${i}`;
  if (fade > 0) {
    chains.push(`[${last}][s${i}]xfade=transition=fade:duration=${fade}:offset=${Math.max(0, offset - fade).toFixed(3)}[${label}]`);
    offset += durations[i] - fade;
  } else {
    chains.push(`[${last}][s${i}]concat=n=2:v=1:a=0[${label}]`);
    offset += durations[i];
  }
  last = label;
}
if (segments.length === 1) chains.push(`[s0]null[v]`);
const cmd = ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', chains.join(';'), '-map', '[v]', '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(fps), '-movflags', '+faststart', out];
console.error(`[assemble] ${segments.length} segments, ${offset.toFixed(1)} s -> ${out}\nffmpeg ${cmd.map((a) => (/\s|\[/.test(a) ? `"${a}"` : a)).join(' ')}`);
const run = spawnSync('ffmpeg', cmd, { stdio: 'inherit', windowsHide: true });
if (run.status !== 0) process.exit(run.status ?? 1);
console.log(out);
