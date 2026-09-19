// Replay clock. Driven from the render loop timestamp so it stays in step with frames.
export class ReplayClock {
  constructor({ duration, t = 0, speed = 1, loop = true, playing = true }) {
    this.duration = Math.max(0.001, duration);
    this.time = Math.min(Math.max(0, t), this.duration);
    this.speed = speed > 0 ? speed : 1;
    this.loop = loop;
    this.playing = playing;
    this.last = null;
    this.listeners = new Set();
  }

  /** Advance from the animation-loop timestamp (ms). Returns the current time. */
  update(nowMs) {
    if (this.last === null) this.last = nowMs;
    const dt = (nowMs - this.last) / 1000;
    this.last = nowMs;
    if (this.playing && dt > 0) {
      this.time += Math.min(dt, 0.25) * this.speed; // ignore tab-switch gaps
      if (this.time >= this.duration) {
        if (this.loop) this.time -= this.duration;
        else {
          this.time = this.duration;
          this.playing = false;
        }
      }
    }
    return this.time;
  }

  play() {
    this.playing = true;
    this.emit();
  }
  pause() {
    this.playing = false;
    this.emit();
  }
  toggle() {
    this.playing = !this.playing;
    this.emit();
  }
  restart() {
    this.time = 0;
    this.playing = true;
    this.emit();
  }
  seek(t) {
    this.time = Math.min(Math.max(0, t), this.duration);
    this.emit();
  }
  setSpeed(s) {
    if (s > 0) this.speed = s;
    this.emit();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit() {
    for (const fn of this.listeners) fn(this);
  }
}
