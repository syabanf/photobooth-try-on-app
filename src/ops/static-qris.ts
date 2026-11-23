// The shop's own static QRIS as a payment gateway: money goes straight to the shop's account, and
// the booth computer (scripts/qris-mutations.mjs) learns it arrived from the notifications a phone
// forwards. This side registers each charge there, builds the QR, and asks what has been paid.

import { uuid } from '../uuid';
import type { PaidListener, PaymentGateway, QrisCharge } from './adapters';
import { lockQrisAmount } from './encoders';
import type { GatewaySettings } from './model';

const POLL_MS = 2_500;

export class StaticQrisGateway implements PaymentGateway {
  readonly simulated = false;
  readonly label = 'QRIS statis';
  private listeners = new Set<PaidListener>();
  private since = 0;
  private quiet: number | null | undefined;
  /** Sets this device's charges apart on the booth computer, where every device's charges meet. */
  private readonly device: string;

  constructor(
    private readonly settings: () => GatewaySettings,
    /** True while this device shows a QR nobody has paid yet; the only time it asks the booth computer. */
    waiting: () => boolean,
    key: string,
  ) {
    const stored = `${key}:qris-device`;
    this.device = localStorage.getItem(stored) ?? uuid().slice(0, 8);
    localStorage.setItem(stored, this.device);
    if (typeof document === 'undefined') return;
    setInterval(() => {
      if (waiting() && !document.hidden) void this.check();
    }, POLL_MS);
  }

  async createQris(amount: number, reference: string, expiresInMs: number): Promise<QrisCharge> {
    const { staticQris, uniqueCode, lockAmount } = this.settings();
    if (!staticQris) throw new Error('Tempel QRIS toko di Pembayaran, bagian Gateway, terlebih dulu.');
    const reply = await fetch('/api/qris/charges', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: `${this.device}:${reference}`, amount, expiresInMs, uniqueCode }),
    }).catch(() => null);
    if (!reply) throw new Error('Komputer booth tidak menjawab. Periksa jaringan lalu coba lagi.');
    const charge = (await reply.json().catch(() => ({}))) as { code?: number; total?: number; error?: string };
    if (!reply.ok || charge.total === undefined) throw new Error(charge.error ?? 'QRIS statis harus dibuka dari komputer booth (pnpm serve).');
    return { reference, amount, uniqueCode: charge.code ?? 0, qrString: lockAmount ? lockQrisAmount(staticQris, charge.total) : staticQris.trim() };
  }

  /** Frees the charge's amount for the next customer once its QR is cancelled or replaced. */
  release(reference: string): void {
    void fetch(`/api/qris/charges/${encodeURIComponent(`${this.device}:${reference}`)}`, { method: 'DELETE' }).catch(() => {});
  }

  phoneQuietMs(): number | null | undefined {
    return this.quiet;
  }

  onPaid(listener: PaidListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Asks the booth computer what was paid since the last ask, and reports this device's QRs. */
  async check(): Promise<void> {
    const reply = await fetch(`/api/qris/paid?since=${this.since}`).catch(() => null);
    if (!reply?.ok) return;
    const { paid, now, lastContact } = (await reply.json()) as { paid: string[]; now: number; lastContact: number | null };
    this.since = now;
    this.quiet = lastContact === null ? null : now - lastContact;
    const mine = `${this.device}:`;
    for (const key of paid) if (key.startsWith(mine)) for (const listener of this.listeners) listener(key.slice(mine.length));
  }
}
