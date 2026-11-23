// The setup guide's checklist: what a new venue fills in, in the order that works, and whether
// each step is done. Pure, so the guide page and the dashboard read the same answer.

import type { Sites } from '../account/model';
import type { OpsState } from './model';

export type SetupStepId = 'locations' | 'device' | 'kiosk' | 'prices' | 'camera' | 'printer' | 'payments' | 'branding' | 'frames' | 'team';

export interface SetupStep {
  id: SetupStepId;
  title: string;
  detail: string;
  done: boolean;
  /** What is still missing, in a few words, when the step is not done. */
  missing: string;
  /** Optional steps never hold up "ready to open". */
  optional: boolean;
  /** The step needs a booth first, so its button waits. */
  blocked: boolean;
}

const names = (points: Sites['points']) => points.map((point) => point.name).join(', ');

/** Steps that make no sense before the first booth exists. */
const NEEDS_BOOTH = new Set<SetupStepId>(['device', 'kiosk', 'prices', 'camera', 'printer']);

export function setupSteps(state: OpsState, sites: Sites, devicePoint: string | null): SetupStep[] {
  const booths = sites.points.filter((point) => point.active);
  const without = (has: (boothId: string) => boolean) => booths.filter((point) => !has(point.id));
  const unpriced = without((id) => state.booths.some((profile) => profile.pointId === id));
  const noCamera = without((id) => state.cameras.some((profile) => profile.boothId === id));
  const noPrinter = without((id) => state.printers.some((printer) => printer.boothIds.includes(id)));
  const { gateway } = state.settings.payments;
  const people = state.staff.filter((person) => person.active);

  const steps: Omit<SetupStep, 'blocked'>[] = [
    {
      id: 'locations',
      title: 'Lokasi dan booth',
      detail: 'Tempat bisnis berjalan, beserta setiap booth, gerbang atau kiosk di sana.',
      done: booths.length > 0,
      missing: 'Belum ada booth',
      optional: false,
    },
    {
      id: 'device',
      title: 'Hubungkan perangkat ini ke booth',
      detail: 'Perangkat yang terhubung ke booth langsung membuka layar pelanggan, mencetak di sana dan melaporkan kondisinya.',
      done: devicePoint !== null,
      missing: 'Perangkat ini belum terhubung',
      optional: true,
    },
    {
      id: 'kiosk',
      title: 'Kiosk dan layar TV',
      detail: 'Buka kiosk tiap booth dan layar antrean dari halaman Antrean. Keduanya langsung terkunci untuk pelanggan.',
      done: state.activity.some((entry) => entry.kind === 'display.kiosk'),
      missing: 'Belum ada kiosk yang dibuka',
      optional: true,
    },
    {
      id: 'prices',
      title: 'Kategori dan harga booth',
      detail: 'Kategori tiap booth menentukan harga photo strip, GIF, video atau cetakan di sana. Klik booth di bagian Booth untuk memastikan kategori, zona waktu dan mode sesinya.',
      done: booths.length > 0 && unpriced.length === 0,
      missing: unpriced.length ? `Belum dikonfirmasi: ${names(unpriced)}` : 'Tambah booth dulu',
      optional: false,
    },
    {
      id: 'camera',
      title: 'Kamera per booth',
      detail: 'DSLR lewat alamat IP, webcam atau stream IP, dan fungsinya di booth.',
      done: booths.length > 0 && noCamera.length === 0,
      missing: noCamera.length ? `Belum diatur: ${names(noCamera)}` : 'Tambah booth dulu',
      optional: false,
    },
    {
      id: 'printer',
      title: 'Printer dan kertas',
      detail: 'Printer untuk tiap booth, ukuran kertasnya dan sisa kertas.',
      done: booths.length > 0 && noPrinter.length === 0,
      missing: noPrinter.length ? `Belum ada printer: ${names(noPrinter)}` : 'Tambah booth dulu',
      optional: false,
    },
    {
      id: 'payments',
      title: 'Gateway pembayaran',
      detail: 'QRIS toko sendiri atau merchant ID dan client key dari gateway, serta metode bayar yang diterima kasir dan booth.',
      done: gateway.provider === 'static' ? Boolean(gateway.staticQris) : Boolean(gateway.merchantId && gateway.clientKey),
      missing: gateway.provider === 'static' ? 'QRIS toko belum ditempel' : 'Merchant ID atau client key belum diisi',
      optional: false,
    },
    {
      id: 'branding',
      title: 'Merek',
      detail: 'Logo, warna dan kalimat sambutan di booth, kiosk, TV dan halaman foto.',
      done: Boolean(state.branding.logo),
      missing: 'Belum ada logo',
      optional: true,
    },
    {
      id: 'frames',
      title: 'Bingkai cetak',
      detail: 'Desain sendiri di sekeliling foto. Tanpa bingkai, booth mencetak strip polos.',
      done: state.frames.some((frame) => frame.active),
      missing: 'Belum ada bingkai diunggah',
      optional: true,
    },
    {
      id: 'team',
      title: 'Tim',
      detail: 'Kasir, operator dan supervisor, masing-masing dengan peran dan akses masuk.',
      done: people.length > 1,
      missing: 'Baru ada pemilik',
      optional: true,
    },
  ];
  return steps.map((step) => ({ ...step, blocked: booths.length === 0 && NEEDS_BOOTH.has(step.id) }));
}

/** Done and total counts; ready once every required step is done. */
export function setupProgress(steps: readonly SetupStep[]): { done: number; total: number; ready: boolean } {
  return { done: steps.filter((step) => step.done).length, total: steps.length, ready: steps.every((step) => step.done || step.optional) };
}
