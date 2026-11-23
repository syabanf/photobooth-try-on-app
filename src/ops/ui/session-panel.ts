// The booth's customer flow beside the camera: pick a mode, pay (QRIS, a voucher or a receipt
// code, or free during an event), choose a frame and effects, shoot, print, and take the QR to
// the soft files. Ads play when the booth sits idle.

import { canvasToBlob, downloadBlob } from '../../render/overlay';
import { saveShot, SHOT_LABELS, type ShotKind } from '../../gallery';
import { extensionOf } from '../../gallery-view';
import { FRAMES, composeBooth } from '../../photobooth';
import { blobUrl } from '../blobs';
import { applyEffects, cssFilter, FILTER_LABELS, gifBurst, recordCamera, recordFrames } from '../capture';
import { amountDue } from '../cart';
import { composeFrame } from '../frames';
import { NO_EFFECTS, SESSION_MODES, type BoothSession, type Effects, type Frame, type PaperSize, type SessionMode, type Voucher } from '../model';
import type { CartLine, Ops } from '../ops';
import { confirmDialog, formDialog } from '../../dialogs';
import { methodAllowed, payable } from '../payments';
import { availableFrames } from '../vouchers';
import { qrClock, qrExact } from './pages/pos';
import { photoDeliveryCheck, publishGallery } from '../delivery';
import { act, actionButton, badge, el, money, notice, pills, qrCanvas } from './kit';

export interface SessionHooks {
  /** The frame on screen, mirrored as shown, with the try-on overlay. */
  grab(): HTMLCanvasElement;
  countdown(seconds: number | null): void;
  flash(): void;
  stage: HTMLElement;
  stageCard: HTMLElement;
  cameraLive(): boolean;
  onSaved(): void;
  openLocations(): void;
  openStaffControls(): void;
}

type Step = 'mode' | 'pay' | 'style' | 'shoot' | 'finish';

interface Result {
  id: string;
  kind: ShotKind;
  blob: Blob;
  url: string;
}

const PRINTABLE: SessionMode[] = ['strip', 'vintage', 'live'];

function fresh() {
  return {
    step: 'mode' as Step,
    mode: 'strip' as SessionMode,
    price: 0,
    voucher: null as Voucher | null,
    discount: 0,
    extraPrints: 0,
    orderId: null as string | null,
    qr: '',
    reference: '',
    frameId: null as string | null,
    effects: { ...NO_EFFECTS },
    session: null as BoothSession | null,
    results: [] as Result[],
    printBlob: null as Blob | null,
    printsLeft: 0,
    consent: false,
    deliveryUrl: null as string | null,
    error: '',
    busy: '',
  };
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A DSLR's JPEG as a canvas, so effects and frames treat it like a preview frame. */
async function blobToCanvas(blob: Blob): Promise<HTMLCanvasElement> {
  const image = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  canvas.getContext('2d')!.drawImage(image, 0, 0);
  image.close();
  return canvas;
}

export function mountSessionPanel(ops: Ops, hooks: SessionHooks) {
  const panel = document.querySelector<HTMLElement>('#sessionPanel')!;
  let flow = fresh();
  let visible = false;
  let stopBts: (() => Promise<Blob | null>) | null = null;
  let unsubscribe: (() => void) | null = null;
  let deliveryOrigin: string | null | undefined;

  const booth = () => ops.hooks.devicePointId();
  /** The frame's size, else the first priced size a printer at this booth takes. */
  const printSize = (): PaperSize => ops.state.frames.find((frame) => frame.id === flow.frameId)?.size ?? ops.printSizeFor(booth());
  const printPrice = () => ops.state.printPrices.find((entry) => entry.size === printSize())?.price ?? 0;
  const due = () => Math.max(0, flow.price - flow.discount) + flow.extraPrints * printPrice();

  function preview(): void {
    if (!visible) return;
    hooks.stage.style.filter = cssFilter(flow.effects);
    hooks.stage.style.transform = `scaleX(${flow.effects.mirror ? -1 : 1}) scale(${flow.effects.zoom})`;
  }

  function resetPreview(): void {
    hooks.stage.style.filter = '';
    hooks.stage.style.transform = '';
  }

  function go(step: Step): void {
    flow.step = step;
    draw();
  }

  function card(title: string, description: string, ...content: (Node | string)[]): HTMLElement {
    const section = el('section', 'card');
    const head = el('header', 'card-head');
    const text = el('div');
    text.append(el('h2', 'card-title', title), el('p', 'card-desc', description));
    const path: Step[] = flow.price === 0 ? ['mode', 'style', 'shoot', 'finish'] : ['mode', 'pay', 'style', 'shoot', 'finish'];
    const progress = flow.step === 'mode' ? 'Pilih sesi' : `${path.indexOf(flow.step) + 1} / ${path.length}`;
    head.append(text, el('span', 'step-count', progress));
    const body = el('div', 'card-body');
    body.append(...content);
    section.append(head, body);
    return section;
  }

  // ---------- 1. mode ----------
  function modeStep(): HTMLElement {
    const id = booth();
    if (!id) {
      const link = actionButton('Hubungkan perangkat ini ke booth', 'btn btn-primary');
      link.addEventListener('click', hooks.openLocations);
      return card('Booth', 'Pilih booth untuk perangkat ini. Harga, printer dan laporan mengikuti booth tersebut.', link);
    }
    const profile = ops.profile(id);
    const grid = el('div', 'mode-grid');
    let event: Voucher | null = null;
    for (const mode of profile.modes) {
      const priced = ops.modePrice(id, mode);
      event = priced.event;
      const category = ops.state.categories.find((entry) => entry.id === profile.categoryId);
      if (!priced.event && category?.prices[mode] === undefined) continue;
      const button = el('button', 'mode-tile');
      button.type = 'button';
      button.append(el('span', 'pos-tile-title', SESSION_MODES[mode].label), el('span', 'pos-tile-meta', SESSION_MODES[mode].detail), el('span', 'pos-tile-price', priced.price === 0 ? 'Gratis' : money(priced.price)));
      button.addEventListener('click', () => {
        flow = { ...fresh(), mode, price: priced.price };
        if (mode === 'vintage') flow.effects.filter = 'vintage';
        go(priced.price === 0 ? 'style' : 'pay');
      });
      grid.append(button);
    }
    const intro = event ? `${(event as Voucher).code}: sesi gratis selama acara ini.` : ops.state.branding.welcome || 'Pilih yang ingin Anda buat.';
    const preflight = el('div', 'booth-preflight');
    preflight.append(el('p', 'kicker', 'Staf: cek unduhan di ponsel'));
    const check = act('Cek lagi', 'btn btn-outline btn-sm', () => void checkDelivery());
    preflight.setAttribute('role', 'status');
    if (deliveryOrigin === undefined) preflight.append(el('p', 'field-hint', 'Mengecek server foto lokal…'));
    else if (!deliveryOrigin) preflight.append(el('p', 'callout', 'Tautan ponsel belum tersedia. Jalankan aplikasi dengan pnpm serve, lalu cek lagi.'), check);
    else preflight.append(
      el('p', 'field-hint', 'Scan QR uji ini dengan ponsel yang terhubung ke Wi-Fi lokasi. Jika ponsel menampilkan “Ponsel terhubung”, ponsel bisa membuka tautan foto.'),
      qrCanvas(`${deliveryOrigin}/connection-test`, 150),
      check,
    );
    return card(ops.boothName(id), intro, grid.childElementCount ? grid : el('p', 'card-desc', 'Belum ada mode yang punya harga di sini. Atur harga di Pengaturan.'), preflight);
  }

  async function checkDelivery(): Promise<void> {
    deliveryOrigin = undefined;
    draw();
    deliveryOrigin = await photoDeliveryCheck();
    if (flow.step === 'mode') draw();
  }

  // ---------- 2. pay ----------
  function payStep(): HTMLElement {
    const id = booth()!;
    const voucherInput = el('input', 'input');
    voucherInput.placeholder = 'Kode voucher atau struk';
    const voucherField = el('label', 'field');
    voucherField.append(el('span', 'field-label', 'Kode voucher atau struk'), voucherInput);
    const apply = act('Pakai', 'btn btn-outline', () => {
      const { voucher, discount } = ops.redeemAtBooth(voucherInput.value, id, flow.price);
      flow.voucher = voucher;
      flow.discount = discount;
      draw();
    });
    const voucherRow = el('div', 'field-row voucher-row');
    voucherRow.append(voucherField, apply);

    const extras = el('div', 'field-row extra-prints');
    if (PRINTABLE.includes(flow.mode) && printPrice()) {
      const minus = actionButton('−', 'btn btn-outline btn-icon');
      minus.setAttribute('aria-label', 'Kurangi satu cetakan tambahan');
      minus.addEventListener('click', () => {
        flow.extraPrints = Math.max(0, flow.extraPrints - 1);
        draw();
      });
      const plus = actionButton('+', 'btn btn-outline btn-icon');
      plus.setAttribute('aria-label', 'Tambah satu cetakan tambahan');
      plus.addEventListener('click', () => {
        flow.extraPrints += 1;
        draw();
      });
      extras.append(el('span', 'field-label', `Cetakan tambahan ${printSize()} · ${money(printPrice())} per lembar`), minus, el('span', 'cart-qty', String(flow.extraPrints)), plus);
    }

    const total = due();
    const summary = el('dl', 'cart-totals');
    summary.append(el('dt', '', SESSION_MODES[flow.mode].label), el('dd', '', money(flow.price)));
    if (flow.discount) summary.append(el('dt', '', flow.voucher!.code), el('dd', '', `−${money(flow.discount)}`));
    if (flow.extraPrints) summary.append(el('dt', '', `${flow.extraPrints} cetakan tambahan`), el('dd', '', money(flow.extraPrints * printPrice())));
    summary.append(el('dt', 'cart-total-label', 'Total bayar'), el('dd', 'cart-total', money(total)));

    const qrArea = el('div', 'pay-qris');
    if (flow.qr) {
      qrArea.append(qrCanvas(flow.qr, 260), el('p', 'card-desc', `Scan dengan aplikasi bank atau e-wallet apa saja · ${ops.gateway.label}`));
      const payment = ops.order(flow.orderId!).payments.find((entry) => entry.reference === flow.reference);
      if (payment) {
        qrArea.append(
          ...[qrExact(ops, payment)].filter((node) => node !== null),
          qrClock(ops, flow.orderId!, payment.id, (status) => {
            // The QR ran out or the cashier cancelled it: the customer can ask for a new one.
            if (status === 'paid') return;
            flow.qr = '';
            flow.reference = '';
            notice(status === 'expired' ? 'Waktu QR habis. Ketuk Bayar untuk QR baru.' : 'Kasir membatalkan QR itu. Ketuk Bayar untuk QR baru.', 'warn');
            draw();
          }),
        );
      }
      if (ops.gateway.simulated) {
        const simulate = actionButton('Simulasi bayar', 'btn btn-outline btn-sm');
        simulate.addEventListener('click', () => ops.gateway.simulatePaid!(flow.reference));
        qrArea.append(badge('Simulator: tidak ada uang yang berpindah', 'warn'), simulate);
      }
    }

    const qrisOff = !methodAllowed(ops.payments, 'qris', 'booth');
    const next = total === 0
      ? act('Mulai', 'btn btn-primary btn-block', () => go('style'))
      : qrisOff
        ? el('p', 'callout', 'Bayar di kasir, lalu ketik kode dari struk di sini.')
        : act(flow.qr ? 'Menunggu pembayaran…' : `Bayar ${money(total)} dengan QRIS`, 'btn btn-primary btn-block', async () => {
          if (flow.qr) return;
          const lines: CartLine[] = [{ kind: 'session', refId: ops.profile(id).categoryId, label: SESSION_MODES[flow.mode].label, unitPrice: flow.price, qty: 1, mode: flow.mode }];
          if (flow.extraPrints) lines.push({ kind: 'print', refId: printSize(), label: `Cetakan tambahan ${printSize()}`, unitPrice: printPrice(), qty: flow.extraPrints, size: printSize() });
          // A retry after an expired QR reuses the open order.
          const order = flow.orderId ? ops.order(flow.orderId) : ops.createOrder({ lines, presetId: null, voucherCode: flow.voucher?.code ?? '', channel: 'booth', branchId: ops.branchOf(id) ?? '', boothId: id });
          flow.orderId = order.id;
          if (order.status === 'paid') return go('style');
          const payment = await ops.chargeQris(order.id);
          flow.qr = payment.qrString ?? '';
          flow.reference = payment.reference;
          unsubscribe?.();
          // The gateway callback marks the order paid; that unlocks the session.
          unsubscribe = ops.store.subscribe(() => {
            if (flow.orderId && amountDue(ops.order(flow.orderId)) === 0 && flow.step === 'pay') {
              unsubscribe?.();
              unsubscribe = null;
              notice('Lunas. Selamat menikmati sesi Anda!', 'ok');
              go('style');
            }
          });
          draw();
        });
    const back = act('Kembali', 'btn btn-ghost btn-block', () => {
      if (flow.orderId) ops.cancelOrder(flow.orderId);
      unsubscribe?.();
      flow = fresh();
      draw();
    });
    return card('Bayar', 'Bayar dengan QRIS, atau ketik voucher atau kode di struk kasir.', voucherRow, extras, summary, qrArea, next, back);
  }

  // ---------- 3. style ----------
  function styleStep(): HTMLElement {
    const frames = availableFrames(ops.state.frames, ops.state.vouchers, flow.voucher);
    const frameGrid = el('div', 'frame-pick');
    if (flow.mode === 'strip' || flow.mode === 'vintage') {
      const none = el('button', `frame-option${flow.frameId === null ? ' is-active' : ''}`, 'Strip klasik');
      none.type = 'button';
      none.addEventListener('click', () => {
        flow.frameId = null;
        draw();
      });
      frameGrid.append(none);
      for (const frame of frames) {
        const option = el('button', `frame-option${flow.frameId === frame.id ? ' is-active' : ''}`);
        option.type = 'button';
        const img = el('img');
        img.alt = frame.name;
        void blobUrl(frame.image).then((url) => (img.src = url));
        option.append(img, el('span', 'rank-meta', frame.name));
        option.addEventListener('click', () => {
          flow.frameId = frame.id;
          draw();
        });
        frameGrid.append(option);
      }
    }

    const filters = pills((Object.keys(FILTER_LABELS) as Effects['filter'][]).map((value) => ({ value, label: FILTER_LABELS[value] })), flow.effects.filter, (filter) => {
      flow.effects.filter = filter;
      preview();
      draw();
    });
    const slider = (key: 'brightness' | 'contrast' | 'saturation' | 'zoom', label: string, min: number, max: number, step: number) => {
      const wrap = el('label', 'size');
      const input = el('input');
      input.type = 'range';
      input.setAttribute('aria-label', label);
      Object.assign(input, { min: String(min), max: String(max), step: String(step), value: String(flow.effects[key]) });
      const out = el('output', '', key === 'zoom' ? `${flow.effects.zoom.toFixed(1)}×` : `${flow.effects[key]}%`);
      input.addEventListener('input', () => {
        flow.effects[key] = Number(input.value);
        out.textContent = key === 'zoom' ? `${Number(input.value).toFixed(1)}×` : `${input.value}%`;
        preview();
      });
      wrap.append(el('span', '', label), input, out);
      return wrap;
    };
    const mirror = act(flow.effects.mirror ? 'Cermin aktif' : 'Cermin mati', 'btn btn-outline btn-sm', () => {
      flow.effects.mirror = !flow.effects.mirror;
      preview();
      draw();
    });
    const start = act('Mulai memotret', 'btn btn-primary btn-block', () => shoot());
    const paid = !!flow.orderId && ops.order(flow.orderId).status === 'paid';
    const back = paid
      ? act('Perlu mengubah? Minta bantuan staf', 'btn btn-outline btn-block', hooks.openStaffControls)
      : act('Kembali ke mode', 'btn btn-outline btn-block', () => {
          flow = fresh();
          resetPreview();
          draw();
        });
    return card(
      'Gaya',
      'Pilih bingkai dan gaya. Cubit layar kamera untuk zoom.',
      ...(frameGrid.childElementCount ? [el('p', 'kicker', 'Bingkai'), frameGrid] : []),
      el('p', 'kicker', 'Filter'),
      filters,
      slider('zoom', 'Zoom', 1, 3, 0.1),
      slider('brightness', 'Kecerahan', 60, 140, 1),
      slider('contrast', 'Kontras', 60, 140, 1),
      slider('saturation', 'Warna', 0, 180, 1),
      mirror,
      start,
      ...(paid ? [el('p', 'field-hint', 'Pembayaran selesai. Staf bisa membantu mengubah atau membatalkan sesi ini.')] : []),
      back,
    );
  }

  // ---------- 4. shoot ----------
  const shotFrame = () => applyEffects(hooks.grab(), flow.effects);

  async function countdown(seconds: number): Promise<void> {
    for (let s = seconds; s > 0; s--) {
      hooks.countdown(s);
      await wait(1000);
    }
    hooks.countdown(null);
  }

  /** A still: from the DSLR at full size when the booth shoots with one, else the preview frame. */
  async function snap(): Promise<HTMLCanvasElement> {
    const id = booth()!;
    await ops.camera?.apply('capture', ops.cameraProfile(id).capture).catch(() => {});
    hooks.flash();
    let frame: HTMLCanvasElement;
    try {
      frame = ops.camera?.shoot ? applyEffects(await blobToCanvas(await ops.camera.shoot()), flow.effects) : shotFrame();
    } catch (error) {
      // The camera missed the shot: the preview frame keeps the session going, and staff hear why.
      notice(`DSLR: ${(error as Error).message} Memakai gambar pratinjau sebagai gantinya.`, 'warn');
      frame = shotFrame();
    }
    await ops.camera?.apply('preview', ops.cameraProfile(id).preview).catch(() => {});
    return frame;
  }

  async function keep(kind: ShotKind, blob: Blob): Promise<void> {
    const shot = await saveShot(blob, kind, booth(), null, flow.session!.id);
    ops.attachShot(flow.session!.id, shot.id);
    flow.results.push({ id: shot.id, kind, blob, url: URL.createObjectURL(blob) });
  }

  async function shoot(): Promise<void> {
    if (!hooks.cameraLive()) {
      notice('Kamera belum menyala.', 'error');
      return;
    }
    const id = booth()!;
    flow.error = '';
    flow.session ??= ops.startSession({ boothId: id, mode: flow.mode, price: due() - flow.extraPrints * printPrice(), orderId: flow.orderId, voucherCode: flow.orderId ? null : (flow.voucher?.code ?? null), frameId: flow.frameId });
    go('shoot');
    const bts = ops.cameraProfile(id).secondaryDeviceId;
    if (bts) stopBts = await recordCamera(bts).catch(() => null);

    try {
      const frame: Frame | undefined = ops.state.frames.find((entry) => entry.id === flow.frameId);
      if (flow.mode === 'strip' || flow.mode === 'vintage') {
        const count = frame ? frame.slots.length : flow.mode === 'vintage' ? 1 : 4;
        const shots: HTMLCanvasElement[] = [];
        for (let i = 0; i < count; i++) {
          flow.busy = `Foto ${i + 1} dari ${count}`;
          draw();
          await countdown(3);
          shots.push(await snap());
          await wait(500);
        }
        let sheet: HTMLCanvasElement;
        if (frame) {
          const art = await createImageBitmap((await fetch(await blobUrl(frame.image)).then((r) => r.blob())));
          sheet = composeFrame(art, frame.width, frame.height, frame.slots, shots);
        } else {
          sheet = await composeBooth(shots, flow.mode === 'vintage' ? 'single' : 'strip', FRAMES[0], ops.state.branding.brandName || ops.account.business, new Date());
        }
        flow.printBlob = await canvasToBlob(sheet);
        await keep('photobooth', flow.printBlob);
      } else if (flow.mode === 'gif') {
        flow.busy = 'Siap-siap bergerak!';
        draw();
        await countdown(3);
        flow.busy = 'Merekam GIF…';
        draw();
        await keep('gif', await gifBurst(shotFrame));
      } else if (flow.mode === 'video') {
        flow.busy = 'Perekaman mulai setelah hitung mundur';
        draw();
        await countdown(3);
        flow.busy = 'Merekam 8 detik…';
        draw();
        await keep('video', await recordFrames(shotFrame, 8));
      } else {
        await countdown(3);
        const still = await snap();
        flow.printBlob = await canvasToBlob(still);
        await keep('snapshot', flow.printBlob);
        flow.busy = 'Tahan posisi untuk bagian live…';
        draw();
        await keep('live', await recordFrames(shotFrame, 3));
      }
      if (stopBts) {
        const clip = await stopBts();
        stopBts = null;
        if (clip) {
          const shot = await saveShot(clip, 'bts', booth(), null, flow.session!.id);
          ops.attachShot(flow.session!.id, shot.id);
        }
      }
      flow.printsLeft = (PRINTABLE.includes(flow.mode) && flow.mode !== 'live' ? 1 : 0) + flow.extraPrints;
      flow.busy = 'Menyiapkan unduhan untuk ponsel…';
      draw();
      flow.deliveryUrl = await publishGallery(
        flow.session.token,
        ops.state.branding.brandName || ops.account.business,
        flow.results,
        ops.state.settings.retentionDays,
      );
      flow.busy = '';
      hooks.onSaved();
      go('finish');
    } catch (error) {
      console.error(error);
      if (stopBts) {
        await stopBts().catch(() => null);
        stopBts = null;
      }
      flow.busy = '';
      flow.error = (error as Error).message || 'Pemotretan tidak selesai.';
      go('finish');
    }
  }

  async function retryCapture(): Promise<void> {
    if (!hooks.cameraLive()) {
      notice('Kamera belum menyala. Minta bantuan staf.', 'error');
      return;
    }
    if (flow.session) await ops.clearSessionShots(flow.session.id);
    for (const result of flow.results) URL.revokeObjectURL(result.url);
    flow.results = [];
    flow.printBlob = null;
    flow.printsLeft = 0;
    flow.deliveryUrl = null;
    flow.error = '';
    await shoot();
  }

  function shootStep(): HTMLElement {
    const progress = el('p', 'queue-now', flow.busy || 'Memulai…');
    progress.setAttribute('role', 'status');
    return card('Senyum!', SESSION_MODES[flow.mode].label, progress);
  }

  // ---------- 5. finish ----------
  function finishStep(): HTMLElement {
    const results = el('div', 'session-results');
    for (const result of flow.results.filter((r) => r.kind !== 'bts')) {
      const media = result.blob.type.startsWith('video/')
        ? Object.assign(el('video'), { src: result.url, autoplay: true, muted: true, loop: true, playsInline: true })
        : Object.assign(el('img'), { src: result.url, alt: '' });
      const save = act(`Simpan ${SHOT_LABELS[result.kind]}`, 'btn btn-outline btn-sm', () => {
        downloadBlob(result.blob, `${result.kind}-${result.id}.${extensionOf(result.blob)}`);
      }, 'download');
      const item = el('div', 'session-result');
      item.append(media, save);
      results.append(item);
    }
    const prints = el('div', 'field-row');
    if (flow.printBlob && flow.printsLeft > 0) {
      prints.append(
        act(`Cetak ${flow.printsLeft === 1 ? 'foto saya' : `${flow.printsLeft} lembar`}`, 'btn btn-secondary', async () => {
          const printer = await ops.print(booth()!, flow.printBlob!, printSize(), flow.printsLeft, flow.session?.id ?? null);
          notice(`Mencetak di ${printer}.`, 'ok');
          flow.printsLeft = 0;
          draw();
        }, 'printer'),
      );
    }
    if (flow.printBlob && printPrice()) {
      prints.append(act(`Beli cetakan · ${money(printPrice())}`, 'btn btn-outline', () => buyPrints(), 'cart'));
    }
    const link = flow.deliveryUrl;
    const consent = el('label', 'consent-gate');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = flow.consent;
    box.addEventListener('change', () => (flow.consent = box.checked));
    consent.append(box, ' Izinkan foto ini tampil di galeri publik acara');
    const closeSession = () => {
      if (flow.session) ops.endSession(flow.session.id, flow.consent, '', flow.deliveryUrl ?? undefined, flow.error || undefined);
      for (const result of flow.results) URL.revokeObjectURL(result.url);
      flow = fresh();
      resetPreview();
      preview();
      draw();
    };
    const done = act(flow.error ? 'Akhiri sesi gagal' : 'Selesai', flow.error ? 'btn btn-ghost btn-block' : 'btn btn-primary btn-block', () => {
      if (!flow.error) return closeSession();
      confirmDialog({
        title: 'Akhiri sesi gagal ini?',
        message: flow.orderId || flow.voucher?.orderId ? 'Pembayaran tetap tercatat. Minta staf memeriksa refund di Transaksi.' : 'Sesi ditutup tanpa foto.',
        confirmLabel: 'Akhiri sesi',
        async run() { closeSession(); },
      });
    });
    const retry = flow.error ? act('Coba foto lagi', 'btn btn-primary btn-block', retryCapture) : null;
    const staffHelp = flow.error ? act('Minta bantuan staf', 'btn btn-outline btn-block', hooks.openStaffControls) : null;
    const retryLink = !link && !flow.error && flow.results.length
      ? act('Coba lagi tautan ponsel', 'btn btn-outline btn-block', async () => {
          flow.deliveryUrl = await publishGallery(flow.session!.token, ops.state.branding.brandName || ops.account.business, flow.results, ops.state.settings.retentionDays);
          draw();
        })
      : null;
    const networkHelp = link
      ? el('p', 'field-hint', 'Hubungkan ponsel ke Wi-Fi lokasi, lalu scan QR. Jika tidak terbuka, minta staf menyimpan file di sini.')
      : null;
    return card(
      flow.error ? 'Pemotretan tidak selesai' : link ? (ops.state.branding.thanks || 'Foto Anda sudah siap') : 'File tersimpan di booth ini',
      flow.error ? `${flow.error} Coba lagi atau minta bantuan staf.` : link ? 'Scan untuk menyimpan file di ponsel Anda.' : 'Unduhan ke ponsel belum tersedia. Simpan file di sini atau minta bantuan staf.',
      results,
      prints,
      link ? qrCanvas(link, 220) : '',
      ...(networkHelp ? [networkHelp] : []),
      ...(retryLink ? [retryLink] : []),
      ...(link && flow.session?.eventId ? [consent] : []),
      ...(retry ? [retry, staffHelp!] : []),
      done,
    );
  }

  /** Post-session extra prints: QRIS for the copies, then they print. */
  function buyPrints(): void {
    formDialog({
      title: 'Tambah cetakan',
      description: `${printSize()} · ${money(printPrice())} per lembar`,
      submitLabel: 'Bayar dengan QRIS',
      fields: [{ name: 'qty', label: 'Jumlah', value: '1', type: 'number' }],
      async submit(values) {
        const qty = Math.round(Number(values.qty));
        if (!(qty > 0 && qty <= 20)) throw new Error('Pilih 1 sampai 20 cetakan.');
        await chargePrints(qty);
      },
    });
  }

  async function chargePrints(qty: number): Promise<void> {
    const id = booth()!;
    const order = ops.createOrder({ lines: [{ kind: 'print', refId: printSize(), label: `Cetakan tambahan ${printSize()}`, unitPrice: printPrice(), qty, size: printSize() }], presetId: null, voucherCode: '', channel: 'booth', branchId: ops.branchOf(id) ?? '', boothId: id });
    const payment = await ops.chargeQris(order.id);
    const area = el('div', 'pay-qris');
    area.append(qrCanvas(payment.qrString ?? '', 240), el('p', 'pay-due', money(payable(payment))), ...[qrExact(ops, payment, { showAmount: false })].filter((node) => node !== null));
    if (ops.gateway.simulated) {
      const simulate = actionButton('Simulasi bayar', 'btn btn-outline btn-sm');
      simulate.addEventListener('click', () => ops.gateway.simulatePaid!(payment.reference));
      area.append(simulate);
    }
    panel.replaceChildren(card('Bayar cetakan', `${qty} × ${printSize()}`, area));
    const stop = ops.store.subscribe(() => {
      if (ops.order(order.id).status !== 'paid') return;
      stop();
      flow.printsLeft += qty;
      draw();
    });
  }

  // ---------- idle ads ----------
  let lastTouch = Date.now();
  let adLayer: HTMLElement | null = null;
  for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, () => {
    lastTouch = Date.now();
    if (adLayer) {
      adLayer.remove();
      adLayer = null;
    }
  }, true);
  setInterval(async () => {
    const { settings, ads } = ops.state;
    const playable = ads.filter((ad) => ad.active);
    if (!visible || adLayer || flow.step !== 'mode' || !settings.adsEnabled || playable.length === 0) return;
    if (Date.now() - lastTouch < settings.idleSeconds * 1000) return;
    adLayer = el('div', 'ad-layer');
    document.body.append(adLayer);
    for (let index = 0; adLayer; index = (index + 1) % playable.length) {
      const ad = playable[index];
      const url = await blobUrl(ad.src);
      if (!adLayer) break;
      const media = ad.kind === 'video' ? Object.assign(el('video'), { src: url, autoplay: true, muted: true, playsInline: true }) : Object.assign(el('img'), { src: url, alt: '' });
      adLayer.replaceChildren(media, el('p', 'ad-hint', 'Ketuk untuk mulai'));
      if (ad.kind === 'video') await new Promise((resolve) => ((media as HTMLVideoElement).onended = media.onerror = resolve));
      else await wait(ad.seconds * 1000);
    }
  }, 1000);

  // ---------- pinch to zoom ----------
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch: { distance: number; zoom: number } | null = null;
  const spread = () => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  hooks.stageCard.addEventListener('pointerdown', (event) => {
    if (!visible) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2) pinch = { distance: spread(), zoom: flow.effects.zoom };
  });
  hooks.stageCard.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinch && pointers.size === 2) {
      flow.effects.zoom = Math.min(3, Math.max(1, (pinch.zoom * spread()) / pinch.distance));
      preview();
    }
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
    hooks.stageCard.addEventListener(type, (event) => {
      pointers.delete((event as PointerEvent).pointerId);
      if (pointers.size < 2) pinch = null;
    });
  }
  hooks.stageCard.style.touchAction = 'none';

  function draw(): void {
    if (!visible) return;
    const steps: Record<Step, () => HTMLElement> = { mode: modeStep, pay: payStep, style: styleStep, shoot: shootStep, finish: finishStep };
    panel.replaceChildren(steps[flow.step]());
  }

  // Prices, vouchers and frames can change from another window; redraw the calm steps.
  ops.store.subscribe(() => {
    if (flow.step === 'mode' || flow.step === 'style') draw();
  });

  return {
    step(): Step {
      return flow.step;
    },
    show(): void {
      visible = true;
      preview();
      draw();
      if (deliveryOrigin === undefined) void checkDelivery();
    },
    hide(): void {
      visible = false;
      resetPreview();
    },
  };
}
