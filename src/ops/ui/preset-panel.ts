// AI presets beside the camera: the party's ticket (or a fresh face capture) brings up the faces
// the entrance camera took, the customer picks who is in the picture, sees every template already
// filled with them, pays for the one they like, and the AI redraws it for the print.

import { readStoredKey, restylePreset, storeKey } from '../../decart';
import { saveShot } from '../../gallery';
import { canvasToBlob } from '../../render/overlay';
import { blobUrl } from '../blobs';
import { amountDue } from '../cart';
import type { FaceRecord, Ticket, Voucher } from '../model';
import type { Ops } from '../ops';
import { methodAllowed } from '../payments';
import { PRESET_SIZE, suggestPreset } from '../presets';
import { act, actionButton, badge, count, el, money, notice, qrCanvas } from './kit';
import { nameButton } from './face-tag';
import { qrClock } from './pages/pos';
import { faceBitmaps, fillTemplates, presetTemplates, type Render } from './preset-render';

export interface PresetHooks {
  /** A 4:5 headshot of whoever faces the camera; throws when no face is found. */
  captureFace(): Promise<HTMLCanvasElement>;
  countdown(seconds: number | null): void;
  flash(): void;
  share(blob: Blob, name: string): void;
  onSaved(): void;
}

type Step = 'start' | 'faces' | 'templates' | 'pay' | 'result';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function mountPresetPanel(ops: Ops, hooks: PresetHooks) {
  const panel = document.querySelector<HTMLElement>('#presetPanel')!;
  let visible = false;
  let step: Step = 'start';
  let busy = '';
  /** The party's queue ticket, when they have one: its faces come first and are picked already. */
  let ticket: Ticket | null = null;
  /** Faces captured since this customer started, for the "only this visit" library. */
  const visit = new Set<string>();
  const selected = new Set<string>();
  let renders: Render[] = [];
  let chosen: Render | null = null;
  let aiBlob: Blob | null = null;
  let aiUrl = '';
  let showAi = false;
  let renderToken = 0;
  const faceBitmap = faceBitmaps();
  const templates = () => presetTemplates(ops);
  // Payment for the print, one order per party.
  let orderId: string | null = null;
  let paid = false;
  let voucher: Voucher | null = null;
  let discount = 0;
  let qr = '';
  let reference = '';
  let unsubscribe: (() => void) | null = null;

  const booth = () => ops.hooks.devicePointId();
  const price = () => ops.state.settings.presetPrice;
  /** Prints are sold only where this device is a booth; elsewhere the preset is a free tool. */
  const priced = () => price() > 0 && !!booth();
  const due = () => Math.max(0, price() - discount);

  /** The library the booth shows: every face kept, or only this customer's, as Settings says. */
  const library = () => ops.state.faces.filter((face) => ops.state.settings.faceLibrary === 'all' || visit.has(face.id));
  const party = () => (ticket ? ops.facesForTicket(ticket.id) : []);

  function card(title: string, description: string, ...content: (Node | string)[]): HTMLElement {
    const section = el('section', 'card');
    const head = el('header', 'card-head');
    const text = el('div');
    text.append(el('h2', 'card-title', title), el('p', 'card-desc', description));
    head.append(text);
    if (ticket) head.append(badge(ticket.number, 'info'));
    const body = el('div', 'card-body');
    body.append(...content);
    section.append(head, body);
    return section;
  }

  function go(next: Step): void {
    step = next;
    draw();
  }

  function reset(): void {
    ticket = null;
    selected.clear();
    visit.clear();
    clearAi();
    orderId = null;
    paid = false;
    voucher = null;
    discount = 0;
    qr = '';
    reference = '';
    unsubscribe?.();
    unsubscribe = null;
    go('start');
  }

  // ---------- 1. start ----------
  async function capture(): Promise<void> {
    busy = 'Look at the camera…';
    draw();
    try {
      for (let s = 3; s > 0; s--) {
        hooks.countdown(s);
        await wait(1000);
      }
      hooks.countdown(null);
      hooks.flash();
      const crop = await hooks.captureFace();
      const face = await ops.addFace(await canvasToBlob(crop, 'image/jpeg', 0.92), booth(), ticket?.id ?? null);
      visit.add(face.id);
      selected.add(face.id);
      busy = '';
      go('faces');
    } catch (error) {
      hooks.countdown(null);
      busy = '';
      notice((error as Error).message, 'error');
      draw();
    }
  }

  /** The party's faces from the gate are picked already; they still add or drop anyone. */
  function useTicket(found: Ticket): void {
    ticket = found;
    selected.clear();
    for (const face of party()) selected.add(face.id);
    go('faces');
  }

  function startStep(): HTMLElement {
    const content: HTMLElement[] = [];
    const serving = ops.servingAt(booth());
    if (serving) {
      const faces = ops.facesForTicket(serving.id).length;
      content.push(act(`Continue as ${serving.number}${faces ? ` · ${count(faces, 'face')}` : ''}`, 'btn btn-primary btn-block', () => useTicket(serving), 'ticket'));
    }
    const form = el('form', 'field-row');
    const input = el('input', 'input');
    input.placeholder = 'Ticket number or QR';
    input.autocomplete = 'off';
    input.setAttribute('aria-label', 'Ticket number or QR');
    const find = el('button', 'btn btn-outline', 'Find');
    find.type = 'submit';
    form.append(input, find);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      try {
        useTicket(ops.findTicket(input.value));
      } catch (error) {
        notice((error as Error).message, 'error');
      }
    });
    content.push(form);
    const start = actionButton(busy || 'Capture my face', `btn ${serving ? 'btn-outline' : 'btn-primary'} btn-block`);
    start.disabled = !!busy;
    start.addEventListener('click', () => void capture());
    content.push(start);
    const saved = actionButton(`Choose from ${ops.state.faces.length} saved faces`, 'btn btn-ghost btn-block');
    saved.hidden = ops.state.settings.faceLibrary !== 'all' || ops.state.faces.length === 0;
    saved.addEventListener('click', () => go('faces'));
    content.push(saved);
    return card('AI presets', 'Scan your ticket to find the photos taken at the entrance, or capture your face here. Pick a template and the AI makes it real.', ...content);
  }

  // ---------- 2. faces ----------
  function faceTile(face: FaceRecord): HTMLElement {
    const tile = el('button', `face-tile${selected.has(face.id) ? ' is-selected' : ''}`);
    tile.type = 'button';
    tile.setAttribute('aria-pressed', String(selected.has(face.id)));
    const img = el('img');
    img.alt = face.name || 'Captured face';
    void blobUrl(face.image).then((url) => (img.src = url));
    tile.append(img);
    if (visit.has(face.id)) tile.append(badge('New', 'ok'));
    tile.addEventListener('click', () => {
      if (selected.has(face.id)) selected.delete(face.id);
      else selected.add(face.id);
      draw();
    });
    const wrap = el('div', 'face-cell');
    wrap.append(tile, nameButton(ops, face));
    return wrap;
  }

  function faceGrid(faces: readonly FaceRecord[], empty: string): HTMLElement {
    const grid = el('div', 'face-grid');
    for (const face of faces) grid.append(faceTile(face));
    if (faces.length === 0) grid.append(el('p', 'card-desc', empty));
    return grid;
  }

  function facesStep(): HTMLElement {
    const group = party();
    const inGroup = new Set(group.map((face) => face.id));
    const others = library().filter((face) => !inGroup.has(face.id));
    const shown = [...group, ...others];

    const content: (HTMLElement | string)[] = [];
    if (ticket) {
      content.push(el('p', 'kicker', `Your party · ${ticket.number}`), faceGrid(group, 'The entrance camera has no photo for this ticket. Capture a face here instead.'));
      if (others.length) content.push(el('p', 'kicker', 'Everyone else'), faceGrid(others, ''));
    } else {
      content.push(faceGrid(others, 'No faces yet. Capture one first.'));
    }

    const tools = el('div', 'field-row');
    tools.append(
      act('Select all', 'btn btn-ghost btn-sm', () => {
        for (const face of shown) selected.add(face.id);
        draw();
      }),
      act('Clear', 'btn btn-ghost btn-sm', () => {
        selected.clear();
        draw();
      }),
      act('Capture another', 'btn btn-outline btn-sm', () => void capture(), 'camera'),
    );
    const next = actionButton(selected.size ? `Use ${count(selected.size, 'face')}` : 'Pick a face', 'btn btn-primary btn-block');
    next.disabled = selected.size === 0;
    next.addEventListener('click', () => {
      go('templates');
      void renderAll();
    });
    const scope = ticket
      ? 'Tap everyone who is in the picture, and drop anyone who is not.'
      : ops.state.settings.faceLibrary === 'all'
        ? `Every face captured here in the last ${ops.state.settings.retentionDays || '∞'} days. Tap to pick one or several.`
        : 'Faces from this visit only. Tap to pick one or several.';
    return card('Faces', scope, tools, ...content, next);
  }

  // ---------- 3. templates ----------
  /** Fills every template with the chosen faces, the suggested one first. */
  async function renderAll(): Promise<void> {
    const token = ++renderToken;
    for (const render of renders) URL.revokeObjectURL(render.url);
    renders = [];
    const faces = await Promise.all(ops.state.faces.filter((face) => selected.has(face.id)).map(faceBitmap));
    for await (const render of fillTemplates(ops, faces)) {
      if (token !== renderToken) return;
      renders.push(render);
      if (step === 'templates') draw();
    }
  }

  function templatesStep(): HTMLElement {
    const suggested = suggestPreset(templates(), selected.size);
    const grid = el('div', 'preset-grid');
    for (const render of renders) {
      const tile = el('button', `preset-tile${render.preset.id === suggested?.id ? ' is-suggested' : ''}`);
      tile.type = 'button';
      const img = el('img');
      img.src = render.url;
      img.alt = render.preset.name;
      tile.append(img, el('span', 'rank-name', render.preset.name));
      if (render.preset.id === suggested?.id) tile.append(badge('Suggested', 'info'));
      tile.addEventListener('click', () => {
        chosen = render;
        clearAi();
        go(priced() && !paid ? 'pay' : 'result');
      });
      grid.append(tile);
    }
    if (renders.length < templates().length) grid.append(el('p', 'card-desc', 'Filling templates…'));
    const back = act('Change faces', 'btn btn-ghost btn-block', () => go('faces'));
    const intro = priced() && !paid ? `Each one already has your faces. Tap the one you like: a print costs ${money(price())}.` : 'Each one already has your faces. Tap the one you like.';
    return card('Templates with you in them', intro, grid, back);
  }

  // ---------- 4. pay ----------
  function payStep(): HTMLElement {
    const id = booth()!;
    const picked = el('div', 'pay-preset');
    const thumb = el('img');
    thumb.src = chosen!.url;
    thumb.alt = chosen!.preset.name;
    picked.append(thumb, el('span', 'rank-name', chosen!.preset.name));

    const voucherInput = el('input', 'input');
    voucherInput.placeholder = 'Voucher or receipt code';
    const voucherRow = el('div', 'field-row');
    voucherRow.append(voucherInput, act('Apply', 'btn btn-outline', () => {
      const redeemed = ops.redeemAtBooth(voucherInput.value, id, price());
      voucher = redeemed.voucher;
      discount = redeemed.discount;
      draw();
    }));

    const total = due();
    const summary = el('dl', 'cart-totals');
    summary.append(el('dt', '', `AI preset · ${chosen!.preset.name}`), el('dd', '', money(price())));
    if (discount) summary.append(el('dt', '', voucher!.code), el('dd', '', `−${money(discount)}`));
    summary.append(el('dt', 'cart-total-label', 'To pay'), el('dd', 'cart-total', money(total)));

    const qrArea = el('div', 'pay-qris');
    if (qr) {
      qrArea.append(qrCanvas(qr, 260), el('p', 'card-desc', `Scan with any bank or e-wallet app · ${ops.gateway.label}`));
      const payment = ops.order(orderId!).payments.find((entry) => entry.reference === reference);
      if (payment) {
        qrArea.append(
          qrClock(ops, orderId!, payment.id, (status) => {
            if (status === 'paid') return;
            qr = '';
            reference = '';
            notice(status === 'expired' ? 'The QR ran out. Tap Pay for a new one.' : 'The cashier cancelled that QR. Tap Pay for a new one.', 'warn');
            draw();
          }),
        );
      }
      if (ops.gateway.simulated) {
        const simulate = actionButton('Simulate payment', 'btn btn-outline btn-sm');
        simulate.addEventListener('click', () => ops.gateway.simulatePaid!(reference));
        qrArea.append(badge('Simulator: no money moves', 'warn'), simulate);
      }
    }

    const order = () => {
      // A retry after an expired QR reuses the open order.
      if (orderId) return ops.order(orderId);
      const created = ops.createOrder({
        lines: [{ kind: 'preset', refId: chosen!.preset.id, label: `AI preset · ${chosen!.preset.name}`, unitPrice: price(), qty: 1 }],
        presetId: null,
        voucherCode: voucher?.code ?? '',
        channel: 'booth',
        branchId: ops.branchOf(id) ?? '',
        boothId: id,
      });
      orderId = created.id;
      return created;
    };
    const settle = () => {
      unsubscribe?.();
      unsubscribe = null;
      paid = true;
      go('result');
    };
    const next = total === 0
      ? act('Continue', 'btn btn-primary btn-block', () => {
        order();
        settle();
      })
      : !methodAllowed(ops.payments, 'qris', 'booth')
        ? el('p', 'callout', 'Pay at the cashier and type the code from your receipt here.')
        : act(qr ? 'Waiting for payment…' : `Pay ${money(total)} with QRIS`, 'btn btn-primary btn-block', async () => {
          if (qr) return;
          if (order().status === 'paid') return settle();
          const payment = await ops.chargeQris(orderId!);
          qr = payment.qrString ?? '';
          reference = payment.reference;
          unsubscribe?.();
          // The gateway callback marks the order paid; that unlocks the print.
          unsubscribe = ops.store.subscribe(() => {
            if (orderId && amountDue(ops.order(orderId)) === 0 && step === 'pay') {
              notice('Paid. The AI gets to work.', 'ok');
              settle();
            }
          });
          draw();
        });
    const back = act('Other templates', 'btn btn-ghost btn-block', () => {
      if (orderId && ops.order(orderId).status === 'open') ops.cancelOrder(orderId);
      orderId = null;
      qr = '';
      reference = '';
      unsubscribe?.();
      unsubscribe = null;
      go('templates');
    });
    return card('Pay', 'Pay with QRIS, or type a voucher or the code on your cashier receipt.', picked, voucherRow, summary, qrArea, next, back);
  }

  // ---------- 5. result ----------
  function clearAi(): void {
    if (aiUrl) URL.revokeObjectURL(aiUrl);
    aiBlob = null;
    aiUrl = '';
    showAi = false;
  }

  async function makeAi(): Promise<void> {
    const key = readStoredKey();
    if (!key) throw new Error('Paste a Decart API key first.');
    busy = 'The AI is redrawing your template…';
    draw();
    try {
      const template = await canvasToBlob(chosen!.canvas, 'image/jpeg', 0.92);
      aiBlob = await restylePreset(key, template, chosen!.preset.prompt);
      aiUrl = URL.createObjectURL(aiBlob);
      showAi = true;
    } finally {
      busy = '';
      draw();
    }
  }

  async function current(): Promise<Blob> {
    return showAi && aiBlob ? aiBlob : canvasToBlob(chosen!.canvas, 'image/jpeg', 0.92);
  }

  function resultStep(): HTMLElement {
    const preview = el('img', 'preset-result');
    preview.src = showAi && aiUrl ? aiUrl : chosen!.url;
    preview.alt = chosen!.preset.name;
    preview.style.aspectRatio = `${PRESET_SIZE.width} / ${PRESET_SIZE.height}`;

    const ai = el('div', 'form-stack');
    if (!readStoredKey()) {
      const keyRow = el('div', 'field-row');
      const key = el('input', 'input');
      key.type = 'password';
      key.placeholder = 'Decart API key, to make it with AI';
      key.autocomplete = 'off';
      keyRow.append(key, act('Save key', 'btn btn-outline', () => {
        if (!key.value.trim()) throw new Error('Paste the key.');
        storeKey(key.value.trim());
        draw();
      }));
      ai.append(keyRow, el('p', 'field-hint', 'The key stays in this tab and is dropped when it closes. Each AI image is billed by Decart.'));
    } else if (aiBlob) {
      const toggle = el('div', 'pill-tabs pill-tabs--full');
      for (const [value, label] of [[true, 'AI'], [false, 'Template']] as const) {
        const button = el('button', `pill-tab${showAi === value ? ' is-active' : ''}`, label);
        button.type = 'button';
        button.addEventListener('click', () => {
          showAi = value;
          draw();
        });
        toggle.append(button);
      }
      ai.append(toggle);
    } else {
      const make = actionButton(busy || 'Make it with AI', 'btn btn-primary btn-block');
      make.disabled = !!busy;
      make.addEventListener('click', () => makeAi().catch((error) => notice(`AI: ${(error as { message?: string })?.message ?? error}`, 'error')));
      ai.append(make);
    }

    const actions = el('div', 'field-row');
    const id = booth();
    if (id) {
      actions.append(
        act('Print', 'btn btn-secondary', async () => {
          const printer = await ops.print(id, await current(), ops.printSizeFor(id), 1);
          notice(`Printing on ${printer}.`, 'ok');
        }, 'printer'),
      );
    }
    actions.append(
      act('Save', id ? 'btn btn-outline' : 'btn btn-secondary', async () => {
        await saveShot(await current(), 'preset', id);
        hooks.onSaved();
        notice('Saved to the gallery.', 'ok');
      }, 'download'),
      act('Share', 'btn btn-outline', async () => hooks.share(await current(), `${chosen!.preset.id}-${Date.now()}`), 'share'),
    );
    const nav = el('div', 'field-row');
    nav.append(act('Other templates', 'btn btn-ghost', () => go('templates')), act('Done', 'btn btn-ghost', reset));
    const paidNote = paid && orderId ? ` Paid, order ${ops.order(orderId).number}.` : '';
    return card(chosen!.preset.name, (showAi ? 'Made by AI from your template.' : 'Your template. Make it with AI for a real photo look.') + paidNote, preview, ai, actions, nav);
  }

  function draw(): void {
    if (!visible) return;
    const steps: Record<Step, () => HTMLElement> = { start: startStep, faces: facesStep, templates: templatesStep, pay: payStep, result: resultStep };
    panel.replaceChildren(steps[step]());
  }

  // A face deleted elsewhere, a ticket called here, a preset edited: redraw the list steps,
  // unless someone is typing a ticket number into them.
  ops.store.subscribe(() => {
    for (const id of selected) if (!ops.state.faces.some((face) => face.id === id)) selected.delete(id);
    const typing = document.activeElement instanceof HTMLInputElement && panel.contains(document.activeElement) && document.activeElement.value !== '';
    if ((step === 'faces' || step === 'start') && !typing) draw();
  });

  return {
    show(): void {
      visible = true;
      draw();
    },
    hide(): void {
      visible = false;
    },
  };
}
