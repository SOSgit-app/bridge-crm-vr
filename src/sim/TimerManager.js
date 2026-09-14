/**
 * Deterministic scenario clock.
 *
 * Real frame time is accumulated and consumed in fixed 1/60 s steps so that
 * every headset that was ENGAGEd at the same verbal cue fires the same
 * inject at the same tick regardless of its actual frame rate. Injects are
 * fired in strict time order within a step.
 */
export class TimerManager {
  constructor({ step = 1 / 60, maxCatchUp = 0.25 } = {}) {
    this.step = step;
    this.maxCatchUp = maxCatchUp;
    this.t = 0;
    this.tick = 0;
    this.running = false;
    this._acc = 0;
    this._schedule = [];
    this._stepListeners = new Set();
  }

  engage() {
    this.t = 0;
    this.tick = 0;
    this._acc = 0;
    this.running = true;
    for (const s of this._schedule) s.fired = false;
    this._schedule.sort((a, b) => a.t - b.t);
  }

  stop() {
    this.running = false;
  }

  /** Schedule a one-shot callback at absolute scenario time (seconds). */
  at(t, fn, id = null) {
    const entry = { t, fn, id, fired: false };
    this._schedule.push(entry);
    if (this.running) this._schedule.sort((a, b) => a.t - b.t);
    return entry;
  }

  clearSchedule() {
    this._schedule.length = 0;
  }

  onStep(fn) {
    this._stepListeners.add(fn);
    return () => this._stepListeners.delete(fn);
  }

  /** Advance by real delta time; runs zero or more fixed steps. */
  advance(dt) {
    if (!this.running) return;
    this._acc += Math.min(dt, this.maxCatchUp);
    while (this._acc >= this.step - 1e-9) {
      this._acc -= this.step;
      this.tick++;
      this.t = this.tick * this.step;
      for (const s of this._schedule) {
        if (s.fired) continue;
        if (s.t <= this.t + 1e-9) {
          s.fired = true;
          s.fn(this.t, s);
        } else break; // sorted
      }
      for (const fn of this._stepListeners) fn(this.step, this.t);
    }
  }

  static format(t) {
    const total = Math.max(0, Math.floor(t));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  get formatted() {
    return TimerManager.format(this.t);
  }
}
