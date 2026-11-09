// The booth's customer flow beside the camera: pick a mode, pay (QRIS, a voucher or a receipt
// code, or free during an event), choose a frame and effects, shoot, print, and take the QR to
// the soft files. Ads play when the booth sits idle.

import { canvasToBlob, downloadBlob } from '../../render/overlay';
import { saveShot, type ShotKind } from '../../gallery';
import { extensionOf } from '../../gallery-view';
import { FRAMES, composeBooth } from '../../photobooth';
import { blobUrl } from '../blobs';
import { applyEffects, cssFilter, FILTER_LABELS, gifBurst, recordCamera, recordFrames } from '../capture';
import { amountDue } from '../cart';
import { composeFrame } from '../frames';
import { NO_EFFECTS, SESSION_MODES, type BoothSession, type Effects, type Frame, type PaperSize, type SessionMode, type Voucher } from '../model';
import type { CartLine, Ops } from '../ops';
import { confirmDialog, formDialog } from '../../dialogs';
import { methodAllowed } from '../payments';
import { availableFrames } from '../vouchers';
import { qrClock } from './pages/pos';
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
    const progress = flow.step === 'mode' ? 'Choose a session' : `${path.indexOf(flow.step) + 1} / ${path.length}`;
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
      const link = actionButton('Link this device to a booth', 'btn btn-primary');
      link.addEventListener('click', hooks.openLocations);
      return card('Booth', 'This device needs to know which booth it is, for prices, printers and reports.', link);
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
      button.append(el('span', 'pos-tile-title', SESSION_MODES[mode].label), el('span', 'pos-tile-meta', SESSION_MODES[mode].detail), el('span', 'pos-tile-price', priced.price === 0 ? 'Free' : money(priced.price)));
      button.addEventListener('click', () => {
        flow = { ...fresh(), mode, price: priced.price };
        if (mode === 'vintage') flow.effects.filter = 'vintage';
        go(priced.price === 0 ? 'style' : 'pay');
      });
      grid.append(button);
    }
    const intro = event ? `${(event as Voucher).code}: sessions are free during this event.` : ops.state.branding.welcome || 'Pick what you want to make.';
    const preflight = el('div', 'booth-preflight');
    preflight.append(el('p', 'kicker', 'Staff: phone download check'));
    const check = act('Check again', 'btn btn-outline btn-sm', () => void checkDelivery());
    preflight.setAttribute('role', 'status');
    if (deliveryOrigin === undefined) preflight.append(el('p', 'field-hint', 'Checking the local photo server…'));
    else if (!deliveryOrigin) preflight.append(el('p', 'callout', 'Phone links are unavailable. Start the app with pnpm serve, then check again.'), check);
    else preflight.append(
      el('p', 'field-hint', 'Scan this test QR with a phone on the venue Wi-Fi. “Phone connected” confirms the phone can open photo links.'),
      qrCanvas(`${deliveryOrigin}/connection-test`, 150),
      check,
    );
    return card(ops.boothName(id), intro, grid.childElementCount ? grid : el('p', 'card-desc', 'No mode has a price here. Set prices in Settings.'), preflight);
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
    voucherInput.placeholder = 'Voucher or receipt code';
    const voucherField = el('label', 'field');
    voucherField.append(el('span', 'field-label', 'Voucher or receipt code'), voucherInput);
    const apply = act('Apply', 'btn btn-outline', () => {
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
      minus.setAttribute('aria-label', 'Remove one extra print');
      minus.addEventListener('click', () => {
        flow.extraPrints = Math.max(0, flow.extraPrints - 1);
        draw();
      });
      const plus = actionButton('+', 'btn btn-outline btn-icon');
      plus.setAttribute('aria-label', 'Add one extra print');
      plus.addEventListener('click', () => {
        flow.extraPrints += 1;
        draw();
      });
      extras.append(el('span', 'field-label', `Extra ${printSize()} prints · ${money(printPrice())} each`), minus, el('span', 'cart-qty', String(flow.extraPrints)), plus);
    }

    const total = due();
    const summary = el('dl', 'cart-totals');
    summary.append(el('dt', '', SESSION_MODES[flow.mode].label), el('dd', '', money(flow.price)));
    if (flow.discount) summary.append(el('dt', '', flow.voucher!.code), el('dd', '', `−${money(flow.discount)}`));
    if (flow.extraPrints) summary.append(el('dt', '', `${flow.extraPrints} extra prints`), el('dd', '', money(flow.extraPrints * printPrice())));
    summary.append(el('dt', 'cart-total-label', 'To pay'), el('dd', 'cart-total', money(total)));

    const qrArea = el('div', 'pay-qris');
    if (flow.qr) {
      qrArea.append(qrCanvas(flow.qr, 260), el('p', 'card-desc', `Scan with any bank or e-wallet app · ${ops.gateway.label}`));
      const payment = ops.order(flow.orderId!).payments.find((entry) => entry.reference === flow.reference);
      if (payment) {
        qrArea.append(
          qrClock(ops, flow.orderId!, payment.id, (status) => {
            // The QR ran out or the cashier cancelled it: the customer can ask for a new one.
            if (status === 'paid') return;
            flow.qr = '';
            flow.reference = '';
            notice(status === 'expired' ? 'The QR ran out. Tap Pay for a new one.' : 'The cashier cancelled that QR. Tap Pay for a new one.', 'warn');
            draw();
          }),
        );
      }
      if (ops.gateway.simulated) {
        const simulate = actionButton('Simulate payment', 'btn btn-outline btn-sm');
        simulate.addEventListener('click', () => ops.gateway.simulatePaid!(flow.reference));
        qrArea.append(badge('Simulator: no money moves', 'warn'), simulate);
      }
    }

    const qrisOff = !methodAllowed(ops.payments, 'qris', 'booth');
    const next = total === 0
      ? act('Start', 'btn btn-primary btn-block', () => go('style'))
      : qrisOff
        ? el('p', 'callout', 'Pay at the cashier and type the code from your receipt here.')
        : act(flow.qr ? 'Waiting for payment…' : `Pay ${money(total)} with QRIS`, 'btn btn-primary btn-block', async () => {
          if (flow.qr) return;
          const lines: CartLine[] = [{ kind: 'session', refId: ops.profile(id).categoryId, label: SESSION_MODES[flow.mode].label, unitPrice: flow.price, qty: 1, mode: flow.mode }];
          if (flow.extraPrints) lines.push({ kind: 'print', refId: printSize(), label: `Extra print ${printSize()}`, unitPrice: printPrice(), qty: flow.extraPrints, size: printSize() });
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
              notice('Paid. Enjoy your session!', 'ok');
              go('style');
            }
          });
          draw();
        });
    const back = act('Back', 'btn btn-ghost btn-block', () => {
      if (flow.orderId) ops.cancelOrder(flow.orderId);
      unsubscribe?.();
      flow = fresh();
      draw();
    });
    return card('Pay', 'Pay with QRIS, or type a voucher or the code on your cashier receipt.', voucherRow, extras, summary, qrArea, next, back);
  }

  // ---------- 3. style ----------
  function styleStep(): HTMLElement {
    const frames = availableFrames(ops.state.frames, ops.state.vouchers, flow.voucher);
    const frameGrid = el('div', 'frame-pick');
    if (flow.mode === 'strip' || flow.mode === 'vintage') {
      const none = el('button', `frame-option${flow.frameId === null ? ' is-active' : ''}`, 'Classic strip');
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
    const mirror = act(flow.effects.mirror ? 'Mirror on' : 'Mirror off', 'btn btn-outline btn-sm', () => {
      flow.effects.mirror = !flow.effects.mirror;
      preview();
      draw();
    });
    const start = act('Start shooting', 'btn btn-primary btn-block', () => shoot());
    const paid = !!flow.orderId && ops.order(flow.orderId).status === 'paid';
    const back = paid
      ? act('Need to change? Get staff help', 'btn btn-outline btn-block', hooks.openStaffControls)
      : act('Back to modes', 'btn btn-outline btn-block', () => {
          flow = fresh();
          resetPreview();
          draw();
        });
    return card(
      'Look',
      'Pick a frame and a look. Pinch the camera to zoom.',
      ...(frameGrid.childElementCount ? [el('p', 'kicker', 'Frame'), frameGrid] : []),
      el('p', 'kicker', 'Filter'),
      filters,
      slider('zoom', 'Zoom', 1, 3, 0.1),
      slider('brightness', 'Brightness', 60, 140, 1),
      slider('contrast', 'Contrast', 60, 140, 1),
      slider('saturation', 'Colour', 0, 180, 1),
      mirror,
      start,
      ...(paid ? [el('p', 'field-hint', 'Payment is complete. Staff can help change or cancel this session.')] : []),
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

  async function snap(): Promise<HTMLCanvasElement> {
    const id = booth()!;
    await ops.camera?.apply('capture', ops.cameraProfile(id).capture).catch(() => {});
    hooks.flash();
    const frame = shotFrame();
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
      notice('The camera is not running.', 'error');
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
          flow.busy = `Shot ${i + 1} of ${count}`;
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
        flow.busy = 'Get ready to move!';
        draw();
        await countdown(3);
        flow.busy = 'Recording the GIF…';
        draw();
        await keep('gif', await gifBurst(shotFrame));
      } else if (flow.mode === 'video') {
        flow.busy = 'Recording starts after the countdown';
        draw();
        await countdown(3);
        flow.busy = 'Recording 8 seconds…';
        draw();
        await keep('video', await recordFrames(shotFrame, 8));
      } else {
        await countdown(3);
        const still = await snap();
        flow.printBlob = await canvasToBlob(still);
        await keep('snapshot', flow.printBlob);
        flow.busy = 'Hold still for the live part…';
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
      flow.busy = 'Preparing phone downloads…';
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
      flow.error = (error as Error).message || 'The capture could not finish.';
      go('finish');
    }
  }

  async function retryCapture(): Promise<void> {
    if (!hooks.cameraLive()) {
      notice('The camera is not running. Ask staff for help.', 'error');
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
    const progress = el('p', 'queue-now', flow.busy || 'Starting…');
    progress.setAttribute('role', 'status');
    return card('Smile!', SESSION_MODES[flow.mode].label, progress);
  }

  // ---------- 5. finish ----------
  function finishStep(): HTMLElement {
    const results = el('div', 'session-results');
    for (const result of flow.results.filter((r) => r.kind !== 'bts')) {
      const media = result.blob.type.startsWith('video/')
        ? Object.assign(el('video'), { src: result.url, autoplay: true, muted: true, loop: true, playsInline: true })
        : Object.assign(el('img'), { src: result.url, alt: '' });
      const save = act(`Save ${result.kind}`, 'btn btn-outline btn-sm', () => {
        downloadBlob(result.blob, `${result.kind}-${result.id}.${extensionOf(result.blob)}`);
      }, 'download');
      const item = el('div', 'session-result');
      item.append(media, save);
      results.append(item);
    }
    const prints = el('div', 'field-row');
    if (flow.printBlob && flow.printsLeft > 0) {
      prints.append(
        act(`Print ${flow.printsLeft === 1 ? 'my photo' : `${flow.printsLeft} copies`}`, 'btn btn-secondary', async () => {
          const printer = await ops.print(booth()!, flow.printBlob!, printSize(), flow.printsLeft, flow.session?.id ?? null);
          notice(`Printing on ${printer}.`, 'ok');
          flow.printsLeft = 0;
          draw();
        }, 'printer'),
      );
    }
    if (flow.printBlob && printPrice()) {
      prints.append(act(`Buy prints · ${money(printPrice())}`, 'btn btn-outline', () => buyPrints(), 'cart'));
    }
    const link = flow.deliveryUrl;
    const consent = el('label', 'consent-gate');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = flow.consent;
    box.addEventListener('change', () => (flow.consent = box.checked));
    consent.append(box, ' Allow these photos in the public event gallery');
    const closeSession = () => {
      if (flow.session) ops.endSession(flow.session.id, flow.consent, '', flow.deliveryUrl ?? undefined, flow.error || undefined);
      for (const result of flow.results) URL.revokeObjectURL(result.url);
      flow = fresh();
      resetPreview();
      preview();
      draw();
    };
    const done = act(flow.error ? 'End failed session' : 'Done', flow.error ? 'btn btn-ghost btn-block' : 'btn btn-primary btn-block', () => {
      if (!flow.error) return closeSession();
      confirmDialog({
        title: 'End this failed session?',
        message: flow.orderId || flow.voucher?.orderId ? 'The payment stays recorded. Ask staff to review a refund in Transactions.' : 'This closes the session without a photo.',
        confirmLabel: 'End session',
        async run() { closeSession(); },
      });
    });
    const retry = flow.error ? act('Try capture again', 'btn btn-primary btn-block', retryCapture) : null;
    const staffHelp = flow.error ? act('Get staff help', 'btn btn-outline btn-block', hooks.openStaffControls) : null;
    const retryLink = !link && !flow.error && flow.results.length
      ? act('Retry phone link', 'btn btn-outline btn-block', async () => {
          flow.deliveryUrl = await publishGallery(flow.session!.token, ops.state.branding.brandName || ops.account.business, flow.results, ops.state.settings.retentionDays);
          draw();
        })
      : null;
    const networkHelp = link
      ? el('p', 'field-hint', 'Connect your phone to the venue Wi-Fi, then scan the QR. If it does not open, ask staff to save the files here.')
      : null;
    return card(
      flow.error ? 'Capture did not finish' : link ? (ops.state.branding.thanks || 'Your photos are ready') : 'Files saved on this booth',
      flow.error ? `${flow.error} Try again or ask staff for help.` : link ? 'Scan to save your files on your phone.' : 'Phone downloads are unavailable. Save the files here or ask staff for help.',
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
      title: 'More prints',
      description: `${printSize()} · ${money(printPrice())} each`,
      submitLabel: 'Pay with QRIS',
      fields: [{ name: 'qty', label: 'How many', value: '1', type: 'number' }],
      async submit(values) {
        const qty = Math.round(Number(values.qty));
        if (!(qty > 0 && qty <= 20)) throw new Error('Pick 1 to 20 prints.');
        await chargePrints(qty);
      },
    });
  }

  async function chargePrints(qty: number): Promise<void> {
    const id = booth()!;
    const order = ops.createOrder({ lines: [{ kind: 'print', refId: printSize(), label: `Extra print ${printSize()}`, unitPrice: printPrice(), qty, size: printSize() }], presetId: null, voucherCode: '', channel: 'booth', branchId: ops.branchOf(id) ?? '', boothId: id });
    const payment = await ops.chargeQris(order.id);
    const area = el('div', 'pay-qris');
    area.append(qrCanvas(payment.qrString ?? '', 240), el('p', 'pay-due', money(order.total)));
    if (ops.gateway.simulated) {
      const simulate = actionButton('Simulate payment', 'btn btn-outline btn-sm');
      simulate.addEventListener('click', () => ops.gateway.simulatePaid!(payment.reference));
      area.append(simulate);
    }
    panel.replaceChildren(card('Pay for prints', `${qty} × ${printSize()}`, area));
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
      adLayer.replaceChildren(media, el('p', 'ad-hint', 'Tap to start'));
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
