// Writes the table-demo QR code (design doc: "A QR code on the table that opens the commander view on the judge's own phone").
//   node scripts/make-qr.mjs                       -> public/qr.png for the deployed commander view of the `fake` scene
//   node scripts/make-qr.mjs --scene hero_small    -> same URL with another scene
//   node scripts/make-qr.mjs --url <full url> --out public/qr-ar.png
// The PNG is committed and served at https://michaelyeh507.github.io/OmniSight/qr.png; regenerate it when the hero scene lands.
import { toFile } from 'qrcode';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const scene = flag('scene', 'fake');
const url = flag('url', `https://michaelyeh507.github.io/OmniSight/?mode=commander&scene=${scene}`);
const out = resolve(flag('out', 'public/qr.png'));
const width = Number(flag('width', '1024'));

// Medium error correction survives a printed sheet with a finger on it; a 4-module quiet zone is the spec minimum.
await toFile(out, url, { type: 'png', width, margin: 4, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
console.log(`${out}\n${url}`);
