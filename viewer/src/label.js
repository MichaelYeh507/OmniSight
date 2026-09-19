// Canvas-backed text sprite: a rounded dark pill with coloured text, drawn through walls (no depth test).
// Shared by the person ghost label and the responder labels. Redraws only when the text changes.
import * as THREE from 'three';

export function makeLabel({ color = '#ff8a4a', width = 0.9 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 160;
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  sprite.renderOrder = 11;
  sprite.scale.set(width, width / 4, 1); // metres; canvas is 4:1
  sprite.frustumCulled = false;
  let current = '';
  return {
    sprite,
    setText(text) {
      if (text === current) return;
      current = text;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.font = 'bold 56px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
      const w = Math.min(canvas.width - 8, ctx.measureText(text).width + 56);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.62)';
      ctx.beginPath();
      ctx.roundRect((canvas.width - w) / 2, 24, w, 112, 56);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, canvas.width / 2, 82);
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
