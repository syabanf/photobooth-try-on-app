// A DSLR as the booth's camera: profiles go to the body, photos come from it at full size, and a
// status check every 30 seconds keeps the connection and battery on Devices current.

import type { CameraDriver, CameraState } from '../ops/adapters';
import type { CameraSettings, DslrSetup } from '../ops/model';
import { dslrClient, type DslrClient } from './protocol';

const CHECK_MS = 30_000;

export class DslrDriver implements CameraDriver {
  readonly kind = 'dslr';
  readonly shoot?: () => Promise<Blob>;
  private readonly client: DslrClient;
  private connected = false;
  private battery: number | null = null;
  private applied: CameraState['applied'] = null;
  private listeners = new Set<(state: CameraState) => void>();
  private readonly timer: number;

  constructor(private readonly setup: DslrSetup) {
    this.client = dslrClient(setup.link);
    if (setup.features.capture) this.shoot = () => this.track(this.client.shoot(setup.features.autofocus));
    void this.check();
    this.timer = window.setInterval(() => void this.check(), CHECK_MS);
  }

  close(): void {
    clearInterval(this.timer);
    this.listeners.clear();
  }

  state(): CameraState {
    return { connected: this.connected, battery: this.setup.features.battery ? this.battery : null, applied: this.applied };
  }

  async apply(profile: 'preview' | 'capture', settings: CameraSettings): Promise<void> {
    if (this.setup.features.settings) await this.track(this.client.apply(settings));
    this.applied = { profile, settings };
    this.emit();
  }

  onChange(listener: (state: CameraState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Any call that reaches the camera proves it is there; one that fails marks it gone. */
  private async track<T>(work: Promise<T>): Promise<T> {
    try {
      const result = await work;
      this.mark(true);
      return result;
    } catch (error) {
      this.mark(false);
      throw error;
    }
  }

  private async check(): Promise<void> {
    try {
      this.battery = this.setup.features.battery ? await this.client.battery() : null;
      this.mark(true);
    } catch {
      this.mark(false);
    }
  }

  private mark(connected: boolean): void {
    const changed = connected !== this.connected;
    this.connected = connected;
    if (changed || connected) this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.state());
  }
}
