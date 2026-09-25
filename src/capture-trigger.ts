// Turns a held hand gesture into a countdown and a single capture. Pure, no DOM.

export interface TriggerOptions {
  /** Gesture names that arm the countdown. */
  gestures: readonly string[];
  /** Consecutive frames the gesture must be held before the countdown starts. */
  holdFrames: number;
  countdownMs: number;
  /** Time after a capture during which gestures are ignored. */
  cooldownMs: number;
}

export interface TriggerState {
  /** Whole seconds left in the countdown, or null when idle. */
  secondsLeft: number | null;
  /** True on the single update where the capture should happen. */
  capture: boolean;
}

export class CaptureTrigger {
  private heldFrames = 0;
  private countdownStart: number | null = null;
  private cooldownUntil = 0;

  constructor(private readonly options: TriggerOptions) {}

  update(gesture: string | null, nowMs: number): TriggerState {
    if (this.countdownStart !== null) {
      const elapsed = nowMs - this.countdownStart;
      if (elapsed >= this.options.countdownMs) {
        this.countdownStart = null;
        this.heldFrames = 0;
        this.cooldownUntil = nowMs + this.options.cooldownMs;
        return { secondsLeft: null, capture: true };
      }
      return { secondsLeft: Math.ceil((this.options.countdownMs - elapsed) / 1000), capture: false };
    }

    if (nowMs < this.cooldownUntil || gesture === null || !this.options.gestures.includes(gesture)) {
      this.heldFrames = 0;
      return { secondsLeft: null, capture: false };
    }

    this.heldFrames += 1;
    if (this.heldFrames >= this.options.holdFrames) {
      this.countdownStart = nowMs;
      return { secondsLeft: Math.ceil(this.options.countdownMs / 1000), capture: false };
    }
    return { secondsLeft: null, capture: false };
  }
}
