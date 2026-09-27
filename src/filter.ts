// One Euro filter (Casiez, Roussel and Vogel, 2012): a low-pass filter whose cutoff rises with
// speed. Landmarks stop shaking while the wearer holds still, and follow at once when they move.

export interface OneEuroOptions {
  /** Cutoff in Hz while still. Lower is steadier, and lags more. */
  minCutoff: number;
  /** How much the cutoff rises per unit of speed. Higher follows fast moves more closely. */
  beta: number;
  /** Cutoff for the speed estimate itself. */
  dCutoff?: number;
}

function alpha(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

/** Filters a vector of values sample by sample; one instance per tracked thing. */
export class OneEuroFilter {
  private values: Float64Array | null = null;
  private speeds: Float64Array | null = null;
  private time = 0;

  constructor(private readonly options: OneEuroOptions) {}

  /** Forgets the history, so the next sample is taken as is. */
  reset(): void {
    this.values = null;
    this.speeds = null;
  }

  /** Returns the smoothed values for a sample taken at `time`, in seconds. */
  filter(sample: readonly number[], time: number): number[] {
    if (!this.values || !this.speeds || this.values.length !== sample.length) {
      this.values = Float64Array.from(sample);
      this.speeds = new Float64Array(sample.length);
      this.time = time;
      return [...sample];
    }
    const dt = Math.max(1e-3, time - this.time);
    this.time = time;
    const { minCutoff, beta, dCutoff = 1 } = this.options;
    const speedAlpha = alpha(dCutoff, dt);
    for (let i = 0; i < sample.length; i++) {
      const speed = (sample[i] - this.values[i]) / dt;
      this.speeds[i] += speedAlpha * (speed - this.speeds[i]);
      const cutoff = minCutoff + beta * Math.abs(this.speeds[i]);
      this.values[i] += alpha(cutoff, dt) * (sample[i] - this.values[i]);
    }
    return Array.from(this.values);
  }
}
