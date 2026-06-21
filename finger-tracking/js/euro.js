// One Euro Filter — low-latency adaptive smoothing for noisy signals.
// Reference: Casiez, Roussel, Vogel (2012). Gives precise tracking with
// minimal lag: smooths jitter when still, follows fast moves with low delay.

class LowPass {
  constructor() {
    this.y = null;   // last raw value
    this.s = null;   // last smoothed value
  }
  hasLast() { return this.y !== null; }
  last() { return this.s; }
  filter(value, alpha) {
    this.s = this.s === null ? value : alpha * value + (1 - alpha) * this.s;
    this.y = value;
    return this.s;
  }
}

export class OneEuroFilter {
  constructor({ minCutoff = 1.0, beta = 0.0, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;   // baseline smoothing (lower = smoother)
    this.beta = beta;             // speed coefficient (higher = less lag on fast moves)
    this.dCutoff = dCutoff;
    this.x = new LowPass();
    this.dx = new LowPass();
    this.lastTime = null;
  }

  setParams({ minCutoff, beta }) {
    if (minCutoff !== undefined) this.minCutoff = minCutoff;
    if (beta !== undefined) this.beta = beta;
  }

  #alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(value, timestampMs) {
    let dt = 1 / 60;
    if (this.lastTime !== null && timestampMs > this.lastTime) {
      dt = (timestampMs - this.lastTime) / 1000;
    }
    this.lastTime = timestampMs;

    const prev = this.x.hasLast() ? this.x.y : value;
    const dValue = (value - prev) / dt;
    const edValue = this.dx.filter(dValue, this.#alpha(this.dCutoff, dt));

    const cutoff = this.minCutoff + this.beta * Math.abs(edValue);
    return this.x.filter(value, this.#alpha(cutoff, dt));
  }
}

// Convenience wrapper to filter a 2D point with shared parameters.
export class PointFilter {
  constructor(opts) {
    this.fx = new OneEuroFilter(opts);
    this.fy = new OneEuroFilter(opts);
  }
  setParams(p) { this.fx.setParams(p); this.fy.setParams(p); }
  filter(x, y, t) {
    return { x: this.fx.filter(x, t), y: this.fy.filter(y, t) };
  }
}
