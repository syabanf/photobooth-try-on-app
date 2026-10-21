// The edges of the system. Each is an interface the app codes against, with the implementation
// this browser build can run. Native and server implementations slot in behind the same shapes:
//
//   PaymentGateway  → a server that calls Midtrans/Xendit/DOKU with the server key and forwards
//                     their payment callback to the booth (webhook → push).
//   CameraDriver    → a native bridge to Canon EDSDK (Electron or a local helper service).
//   printImage      → the OS print queue; Chrome in --kiosk-printing mode prints with no dialog.
//   CloudTransport  → the cloud API the outbox syncs to.

import { qrisPayload } from './encoders';
import type { CameraSettings, PaperSize } from './model';
import { PAPER } from './printing';

// ---------- payments ----------

export interface QrisCharge {
  reference: string;
  qrString: string;
  amount: number;
  expiresAt: number;
}

export type PaidListener = (reference: string) => void;

export interface PaymentGateway {
  readonly label: string;
  /** True when no money moves: the booth shows a "Simulate payment" control. */
  readonly simulated: boolean;
  createQris(amount: number, reference: string): Promise<QrisCharge>;
  /** The gateway's callback, delivered to the booth that showed the QR. */
  onPaid(listener: PaidListener): () => void;
  /** Simulator only: what the gateway callback would do once the customer pays. */
  simulatePaid?(reference: string): void;
}

const QR_LIFETIME_MS = 15 * 60_000;

export class SimulatedGateway implements PaymentGateway {
  readonly simulated = true;
  private listeners = new Set<PaidListener>();
  private channel: BroadcastChannel | null = null;

  constructor(
    readonly label: string,
    private readonly merchant: () => { name: string; city: string },
    key: string,
  ) {
    try {
      // The customer screen in another window can complete a simulated payment too.
      this.channel = new BroadcastChannel(`${key}:payments`);
      this.channel.onmessage = (event) => this.fire(String(event.data));
    } catch {
      this.channel = null;
    }
  }

  async createQris(amount: number, reference: string): Promise<QrisCharge> {
    const { name, city } = this.merchant();
    return {
      reference,
      amount,
      expiresAt: Date.now() + QR_LIFETIME_MS,
      qrString: qrisPayload({ merchantName: `${name || 'BOOTH'} SIMULATOR`.toUpperCase(), merchantCity: (city || 'JAKARTA').toUpperCase(), merchantId: 'SIMULATOR000000', amount, reference }),
    };
  }

  onPaid(listener: PaidListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private fire(reference: string): void {
    for (const listener of this.listeners) listener(reference);
  }

  simulatePaid(reference: string): void {
    this.fire(reference);
    this.channel?.postMessage(reference);
  }
}

// ---------- camera ----------

export interface CameraState {
  connected: boolean;
  battery: number | null;
  applied: { profile: 'preview' | 'capture'; settings: CameraSettings } | null;
}

export interface CameraDriver {
  readonly kind: 'webcam' | 'edsdk';
  state(): CameraState;
  /** Applies a profile. Drivers re-apply the saved preview profile on their own after power-up. */
  apply(profile: 'preview' | 'capture', settings: CameraSettings): Promise<void>;
  onChange(listener: (state: CameraState) => void): () => void;
}

export const DEFAULT_PREVIEW: CameraSettings = { iso: 400, aperture: 4, shutter: '1/60', whiteBalance: 'auto', exposureComp: 0, pictureStyle: 'standard' };
export const DEFAULT_CAPTURE: CameraSettings = { iso: 200, aperture: 5.6, shutter: '1/125', whiteBalance: 'flash', exposureComp: 0, pictureStyle: 'portrait' };

export const ISO_STEPS = [100, 200, 400, 800, 1600, 3200, 6400];
export const APERTURE_STEPS = [1.8, 2.8, 4, 5.6, 8, 11, 16];
export const SHUTTER_STEPS = ['1/30', '1/60', '1/125', '1/160', '1/200', '1/250', '1/500'];

/** Maps the settings a webcam can take (exposure compensation, white balance) onto its track. */
export class WebcamDriver implements CameraDriver {
  readonly kind = 'webcam';
  private applied: CameraState['applied'] = null;
  private listeners = new Set<(state: CameraState) => void>();

  constructor(private readonly track: () => MediaStreamTrack | null) {
    navigator.mediaDevices?.addEventListener?.('devicechange', () => this.emit());
  }

  state(): CameraState {
    return { connected: this.track()?.readyState === 'live', battery: null, applied: this.applied };
  }

  async apply(profile: 'preview' | 'capture', settings: CameraSettings): Promise<void> {
    this.applied = { profile, settings };
    const track = this.track();
    const caps = (track?.getCapabilities?.() ?? {}) as Record<string, unknown>;
    const advanced: Record<string, unknown> = {};
    if ('exposureCompensation' in caps) advanced.exposureCompensation = settings.exposureComp;
    if ('whiteBalanceMode' in caps) advanced.whiteBalanceMode = settings.whiteBalance === 'auto' ? 'continuous' : 'manual';
    if (track && Object.keys(advanced).length) await track.applyConstraints({ advanced: [advanced as MediaTrackConstraintSet] }).catch(() => {});
    this.emit();
  }

  onChange(listener: (state: CameraState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.state());
  }
}

/**
 * Stands in for a Canon body over EDSDK: it keeps the applied settings, drains a battery, and
 * re-applies the saved preview profile when the camera powers back up, the way the native agent
 * will.
 */
export class SimulatedEdsdk implements CameraDriver {
  readonly kind = 'edsdk';
  private connected = true;
  private battery = 100;
  private applied: CameraState['applied'] = null;
  private listeners = new Set<(state: CameraState) => void>();

  constructor(private readonly saved: () => CameraSettings) {}

  state(): CameraState {
    return { connected: this.connected, battery: this.connected ? this.battery : null, applied: this.applied };
  }

  async apply(profile: 'preview' | 'capture', settings: CameraSettings): Promise<void> {
    if (!this.connected) throw new Error('The camera is off.');
    this.applied = { profile, settings };
    if (profile === 'capture') this.battery = Math.max(0, this.battery - 1);
    this.emit();
  }

  /** Simulator controls. */
  powerOff(): void {
    this.connected = false;
    this.applied = null;
    this.emit();
  }

  powerOn(): void {
    this.connected = true;
    void this.apply('preview', this.saved());
  }

  setBattery(level: number): void {
    this.battery = Math.max(0, Math.min(100, level));
    this.emit();
  }

  onChange(listener: (state: CameraState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.state());
  }
}

// ---------- printing ----------

export interface PrintOptions {
  size: PaperSize;
  copies: number;
  /** Width × height in mm for the custom size. */
  customMm?: [number, number];
}

/**
 * Prints an image edge to edge on the chosen paper through the browser's print queue. The page
 * size comes from @page, so the OS driver gets the right media.
 */
export function printImage(image: Blob, options: PrintOptions): Promise<void> {
  const [width, height] = options.size === 'custom' && options.customMm ? options.customMm : [PAPER[options.size].widthMm, PAPER[options.size].heightMm];
  return printDocument(
    `@page { size: ${width}mm ${height}mm; margin: 0 } html, body { margin: 0 } img { display: block; width: ${width}mm; height: ${height}mm; object-fit: cover; page-break-after: always }`,
    (doc) => {
      const url = URL.createObjectURL(image);
      for (let i = 0; i < options.copies; i++) {
        const img = doc.createElement('img');
        img.src = url;
        doc.body.append(img);
      }
      return url;
    },
  );
}

/** Prints any small document, such as a receipt, from a stylesheet and a body builder. */
export function printDocument(css: string, build: (doc: Document) => string | void): Promise<void> {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
    document.body.append(frame);
    const doc = frame.contentDocument!;
    doc.open();
    doc.write(`<!doctype html><html><head><style>${css}</style></head><body></body></html>`);
    doc.close();
    const url = build(doc);
    const images = [...doc.images];
    Promise.all(images.map((img) => (img.complete ? null : new Promise((done) => (img.onload = img.onerror = done))))).then(() => {
      frame.contentWindow!.focus();
      frame.contentWindow!.print();
      setTimeout(() => {
        if (url) URL.revokeObjectURL(url);
        frame.remove();
        resolve();
      }, 1000);
    });
  });
}

// ---------- cloud ----------

export interface CloudTransport {
  online(): boolean;
  send(item: { id: string; kind: string; payload: unknown }): Promise<void>;
  received(): number;
}

/**
 * The cloud end of the sync, kept in this browser. It is idempotent like the real API: an id it
 * already has is acknowledged and ignored. "Simulate offline" makes every send fail.
 */
export class SimulatedCloud implements CloudTransport {
  forcedOffline = false;

  constructor(private readonly key: string) {}

  online(): boolean {
    return !this.forcedOffline && (typeof navigator === 'undefined' || navigator.onLine);
  }

  private ids(): string[] {
    try {
      return JSON.parse(localStorage.getItem(this.key) ?? '[]') as string[];
    } catch {
      return [];
    }
  }

  async send(item: { id: string }): Promise<void> {
    if (!this.online()) throw new Error('Offline');
    const ids = this.ids();
    if (!ids.includes(item.id)) localStorage.setItem(this.key, JSON.stringify([...ids, item.id].slice(-5000)));
  }

  received(): number {
    return this.ids().length;
  }
}
