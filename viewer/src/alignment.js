// Offsets belong to this browser/device. The XR camera always remains pose-driven.
export const ALIGNMENT_KEY = 'omnisight.alignment.v1';
export const AXES = Object.freeze({
  x: { step: 0.01, min: -2, max: 2, unit: 'm' },
  y: { step: 0.01, min: -2, max: 2, unit: 'm' },
  z: { step: 0.01, min: -2, max: 2, unit: 'm' },
  yaw: { step: 0.5, min: -30, max: 30, unit: '°' },
});

function quantize(axis, value) {
  const { min, max, step } = AXES[axis];
  return Number((Math.round(Math.min(max, Math.max(min, value)) / step) * step).toFixed(2));
}

export function resolveAlignment(saved = {}, overrides = {}) {
  return Object.fromEntries(Object.keys(AXES).map((axis) => {
    const value = Number.isFinite(overrides?.[axis]) ? overrides[axis]
      : Number.isFinite(saved?.[axis]) ? saved[axis] : 0;
    return [axis, quantize(axis, value)];
  }));
}

export class Alignment {
  constructor({ sceneRoot, alignmentCloud, overrides = {}, storage }) {
    this.sceneRoot = sceneRoot;
    this.alignmentCloud = alignmentCloud;
    this.storage = storage;
    this.storageError = storage ? '' : 'Storage unavailable. Offsets will only last for this session unless supplied in the URL.';
    let saved;
    try { saved = JSON.parse(storage?.getItem(ALIGNMENT_KEY) || '{}'); }
    catch { this.storageError = 'Saved offsets could not be read. Defaults or URL offsets are in use.'; }
    this.values = resolveAlignment(saved, overrides);
    this.aligning = false;
    this.apply();
    this.setAligning(false);
  }
  apply() {
    const { x, y, z, yaw } = this.values;
    this.sceneRoot.position.set(x, y, z);
    this.sceneRoot.rotation.set(0, yaw * Math.PI / 180, 0);
  }
  set(axis, value) {
    if (!Object.hasOwn(AXES, axis) || !Number.isFinite(value)) return;
    this.values[axis] = quantize(axis, value);
    this.apply();
  }
  nudge(axis, direction) { this.set(axis, this.values[axis] + direction * AXES[axis].step); }
  setAligning(value) {
    this.aligning = !!value;
    if (this.alignmentCloud) this.alignmentCloud.visible = this.aligning;
  }
  save() {
    try {
      if (!this.storage) throw new Error('Storage unavailable');
      this.storage.setItem(ALIGNMENT_KEY, JSON.stringify(this.values));
      this.storageError = '';
      return true;
    } catch {
      this.storageError = 'Storage unavailable. Offsets work for this session; use ax/ay/az/ayaw in the URL to keep them.';
      return false;
    }
  }
  reset() {
    this.values = resolveAlignment();
    this.apply();
    return this.save();
  }
}

export function setupAlignment({ sceneRoot, alignmentCloud, overrides, omni, root = document }) {
  const $ = (id) => root.getElementById(id);
  let storage;
  try { storage = window.localStorage; } catch { /* private/device policy may deny access */ }
  const alignment = new Alignment({ sceneRoot, alignmentCloud, overrides, storage });
  const button = $('btn-align');
  const panel = $('alignment-controls');
  const status = $('alignment-status');
  const paint = () => {
    for (const [axis, settings] of Object.entries(AXES)) {
      const value = alignment.values[axis];
      $(`align-${axis}`).value = String(value);
      $(`align-${axis}-value`).textContent = `${value.toFixed(axis === 'yaw' ? 1 : 2)} ${settings.unit}`;
      $(`align-${axis}-minus`).disabled = value <= settings.min;
      $(`align-${axis}-plus`).disabled = value >= settings.max;
    }
    panel.hidden = !alignment.aligning;
    button.textContent = alignment.aligning ? 'Show x-ray' : 'Align wall';
    button.setAttribute('aria-pressed', String(alignment.aligning));
    button.setAttribute('aria-expanded', String(alignment.aligning));
    $('ro-alignment-mode').textContent = alignment.aligning ? 'Alignment mode' : 'X-ray mode';
    omni.alignment = { ...alignment.values };
    omni.aligning = alignment.aligning;
  };
  const changed = () => { status.textContent = 'Offsets changed. Tap Save offsets to keep them on this device.'; paint(); };
  for (const [axis, settings] of Object.entries(AXES)) {
    const slider = $(`align-${axis}`);
    slider.min = String(settings.min);
    slider.max = String(settings.max);
    slider.step = String(settings.step);
    slider.addEventListener('input', () => { alignment.set(axis, Number(slider.value)); changed(); });
    $(`align-${axis}-minus`).addEventListener('click', () => { alignment.nudge(axis, -1); changed(); });
    $(`align-${axis}-plus`).addEventListener('click', () => { alignment.nudge(axis, 1); changed(); });
  }
  button.addEventListener('click', () => { alignment.setAligning(!alignment.aligning); paint(); });
  $('btn-save-alignment').addEventListener('click', () => {
    status.textContent = alignment.save() ? 'Offsets saved on this device. Start every AR session from the jig.' : alignment.storageError;
  });
  $('btn-reset-alignment').addEventListener('click', () => {
    const saved = alignment.reset();
    status.textContent = saved ? 'Offsets reset and saved. URL overrides apply again on reload.' : alignment.storageError;
    paint();
  });
  const hasOverrides = Object.values(overrides).some(Number.isFinite);
  status.textContent = alignment.storageError || (hasOverrides
    ? 'URL offsets override saved values for this load. Save offsets to keep them.'
    : 'Saved device offsets loaded; start every AR session from the jig.');
  $('alignment-missing').hidden = !!alignmentCloud;
  paint();
  return alignment;
}
