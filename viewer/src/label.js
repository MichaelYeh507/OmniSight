// Canvas-backed text sprite: a dark tag with a coloured accent bar, a bold title line and an optional
// smaller second line, drawn through walls (no depth test). Shared by the person ghost label and the
// responder labels. Redraws only when the text changes.
import * as THREE from 'three';

const W = 640;
const H = 240;

export function makeLabel({ color = '#ff8a4a', width = 0.9 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  sprite.renderOrder = 11;
  sprite.scale.set(width, width * H / W, 1); // metres
  sprite.center.set(0, 0.5); // anchored at the left edge, so a tag hangs to the right of its marker
  sprite.frustumCulled = false;
  let current = '';
  return {
    sprite,
    /** Title line (drawn upper-case, tracked) and an optional smaller second line. */
    setText(text, sub = '') {
      const key = `${text}\n${sub}`;
      if (key === current) return;
      current = key;
      ctx.clearRect(0, 0, W, H);
      // minimal tag: tracked caps in the marker's colour over a dark stroke (legible on cyan or a bright wall), no backplate
      const title = String(text);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.font = '600 52px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
      if ('letterSpacing' in ctx) ctx.letterSpacing = '1px';
      const x = 24;
      const yTitle = sub ? H / 2 - 26 : H / 2;
      ctx.lineWidth = 9;
      ctx.strokeStyle = 'rgba(4, 10, 16, 0.8)';
      ctx.strokeText(title, x, yTitle);
      ctx.fillStyle = color;
      ctx.fillText(title, x, yTitle);
      if (sub) {
        ctx.font = '400 38px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
        ctx.lineWidth = 8;
        ctx.strokeText(sub, x, H / 2 + 28);
        ctx.fillStyle = 'rgba(238, 243, 246, 0.9)';
        ctx.fillText(sub, x, H / 2 + 28);
      }
      texture.needsUpdate = true;
    },
    setOpacity(a) {
      material.opacity = a;
    },
    dispose() {
      texture.dispose();
      material.dispose();
    },
  };
}
