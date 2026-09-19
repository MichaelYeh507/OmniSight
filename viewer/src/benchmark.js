// A timed measurement uses XR animation frames, never the desktop rAF fallback.
export class FrameMeasurement {
  constructor(durationMs = 10000) { this.durationMs = durationMs; this.reset(); }
  reset() { this.start = null; this.frames = 0; this.bucketStart = null; this.bucketFrames = 0; this.minFps = Infinity; }
  tick(now) {
    if (this.start === null) { this.start = this.bucketStart = now; return null; }
    this.frames += 1;
    this.bucketFrames += 1;
    if (now - this.bucketStart >= 500) {
      this.minFps = Math.min(this.minFps, this.bucketFrames * 1000 / (now - this.bucketStart));
      this.bucketFrames = 0;
      this.bucketStart = now;
    }
    const elapsed = now - this.start;
    return elapsed >= this.durationMs ? {
      seconds: elapsed / 1000, frames: this.frames,
      fps: this.frames * 1000 / elapsed, minFps: this.minFps,
    } : null;
  }
}

export function setupBenchmark({ clock, omni, params, button, status }) {
  let measurement = null;
  let warmUntil = null;
  let signature = null;
  const snapshot = () => JSON.stringify([omni.points, omni.xrFramebuffer, omni.resets, omni.alignment, omni.aligning]);
  button.addEventListener('click', () => {
    if (!omni.xrPresenting) return;
    clock.pause();
    clock.seek(clock.duration);
    measurement = new FrameMeasurement();
    warmUntil = null;
    signature = null;
    omni.benchmark = null;
    button.disabled = true;
    status.textContent = 'Warming up for 2 s; hold the phone facing the room.';
  });
  return {
    update(now, frame) {
      if (!measurement) return;
      const cancel = (message) => {
        measurement = null;
        button.disabled = !omni.xrPresenting;
        status.textContent = message;
      };
      if (!frame || !omni.xrPresenting) return cancel('Measurement cancelled: AR ended.');
      if (!omni.tracking || clock.playing || clock.time !== clock.duration) {
        return cancel('Measurement cancelled: tracking or playback changed. Tap Measure again.');
      }
      if (warmUntil === null) warmUntil = now + 2000;
      if (now < warmUntil) return;
      if (signature === null) {
        signature = snapshot();
        status.textContent = 'Measuring 10 s; keep this view and the controls still.';
      }
      if (signature !== snapshot()) return cancel('Measurement cancelled: view settings changed. Tap Measure again.');
      const result = measurement.tick(now);
      if (!result) return;
      omni.benchmark = {
        ...result, scene: params.scene, budget: params.budget, points: omni.points,
        xrFramebuffer: omni.xrFramebuffer, fbscale: params.fbscale, psize: params.psize,
        round: params.round, resets: omni.resets, alignmentVisible: !!omni.aligning,
        userAgent: navigator.userAgent,
      };
      status.textContent = `${result.fps.toFixed(1)} avg / ${result.minFps.toFixed(1)} min (0.5 s) fps · ${omni.points.toLocaleString()} pts`;
      console.log('[omni] point budget', JSON.stringify(omni.benchmark));
      measurement = null;
      button.disabled = false;
    },
  };
}
