// The self-service kiosk (#display=kiosk): a touch screen where a visitor scans their ticket, picks
// who from their party goes into the picture, picks a template, pays with QRIS and takes the print,
// with no staff at the screen. It shows only the faces the gate took for the scanned ticket, and
// goes back to the start after a while without a touch so the next party never sees them.

import { readStoredKey, restylePreset } from '../../decart';
import { icon, type IconName } from '../../icons';
import { canvasToBlob } from '../../render/overlay';
import { blobUrl } from '../blobs';
import { amountDue } from '../cart';
import type { FaceRecord, Ticket, Voucher } from '../model';
import type { Ops } from '../ops';
import { methodAllowed } from '../payments';
import { suggestPreset } from '../presets';
import { el, money, qrCanvas } from './kit';
import { qrClock } from './pages/pos';
import { faceBitmaps, fillTemplates, presetTemplates, type Render } from './preset-render';

type Step = 'scan' | 'faces' | 'templates' | 'pay' | 'making' | 'done';

const IDLE_MS = 90_000;
const DONE_MS = 25_000;
const STEPS: { step: Step; label: string }[] = [
  { step: 'scan', label: 'Tiket' },
  { step: 'faces', label: 'Wajah' },
  { step: 'templates', label: 'Template' },
  { step: 'pay', label: 'Bayar' },
  { step: 'done', label: 'Cetak' },
];

/** Ticket prefixes in use ("A", "B"), for the letter keys on the keypad. */
function prefixes(ops: Ops): string[] {
  const letters = new Set(ops.state.tickets.map((ticket) => /^[A-Z]+/.exec(ticket.number)?.[0]).filter((prefix): prefix is string => !!prefix));
  return [...letters].sort().slice(0, 6);
}

/** A title that ends in the brand's accent period. */
function title(text: string, className: string): HTMLElement {
  const heading = el('h1', className, text);
  heading.append(el('span', 'display-period', '.'));
  return heading;
}

function card(className: string, ...content: (Node | null)[]): HTMLElement {
  const section = el('section', className);
  for (const node of content) if (node) section.append(node);
  return section;
}

export function renderKiosk(ops: Ops, root: HTMLElement, head: HTMLElement): void {
  const boothId = ops.hooks.devicePointId();
  if (!boothId) {
    root.append(card('kiosk-hero kiosk-hero--center', title('Kiosk belum siap', 'kiosk-hero-title'), el('p', 'kiosk-hero-desc', 'Petugas: buka kiosk dari halaman Queue di perangkat yang sudah terhubung ke booth.')));
    return;
  }
  const booth = boothId;
  const faceBitmap = faceBitmaps();
  const progress = el('ol', 'kiosk-steps');
  progress.setAttribute('aria-label', 'Langkah');
  head.append(progress);

  let step: Step = 'scan';
  let error = '';
  let typed = '';
  let ticket: Ticket | null = null;
  const selected = new Set<string>();
  let renders: Render[] = [];
  let renderToken = 0;
  let chosen: Render | null = null;
  let voucher: Voucher | null = null;
  let discount = 0;
  let orderId: string | null = null;
  let qr = '';
  let reference = '';
  let stopWatching: (() => void) | null = null;
  let result = '';

  const price = () => ops.state.settings.presetPrice;
  const due = () => Math.max(0, price() - discount);
  const party = (): FaceRecord[] => (ticket ? ops.facesForTicket(ticket.id) : []);

  // ---------- going back to the start ----------
  let idleTimer = 0;
  /** Idle time counts from the last touch. A QR waiting for payment or a print in progress holds it. */
  const touched = () => {
    clearTimeout(idleTimer);
    if (step === 'scan') return;
    idleTimer = window.setTimeout(() => {
      if ((step === 'pay' && qr) || step === 'making') return touched();
      restart();
    }, step === 'done' ? DONE_MS : IDLE_MS);
  };
  root.addEventListener('pointerdown', touched);
  root.addEventListener('keydown', touched);

  function dropOrder(): void {
    stopWatching?.();
    stopWatching = null;
    if (orderId && ops.order(orderId).status === 'open' && amountDue(ops.order(orderId)) > 0) {
      try {
        ops.cancelOrder(orderId);
      } catch {
        // Part paid: the order stays open for staff to settle.
      }
    }
    orderId = null;
    qr = '';
    reference = '';
  }

  function restart(): void {
    dropOrder();
    renderToken++;
    for (const render of renders) URL.revokeObjectURL(render.url);
    renders = [];
    ticket = null;
    selected.clear();
    chosen = null;
    voucher = null;
    discount = 0;
    typed = '';
    result = '';
    go('scan');
  }

  function go(next: Step): void {
    step = next;
    error = '';
    draw();
    touched();
  }

  function fail(message: string): void {
    error = message;
    draw();
  }

  function button(label: string, className: string, run: () => unknown, iconName?: IconName): HTMLButtonElement {
    const element = el('button', `btn ${className}`, label);
    element.type = 'button';
    if (iconName) element.prepend(icon(iconName));
    element.addEventListener('click', () => {
      try {
        const done = run();
        if (done instanceof Promise) done.catch((reason: Error) => fail(reason.message));
      } catch (reason) {
        fail((reason as Error).message);
      }
    });
    return element;
  }

  /** The sticky bar at the foot of a step: Back on the left, the step's one primary on the right. */
  function bar(...buttons: HTMLElement[]): HTMLElement {
    const row = el('div', 'kiosk-bar');
    row.append(...buttons);
    return row;
  }

  const banner = () => (error ? el('p', 'kiosk-error', error) : null);

  function cardHead(kicker: string, heading: string, description: string, aside?: HTMLElement): HTMLElement {
    const header = el('header', 'kiosk-card-head');
    const text = el('div');
    text.append(el('p', 'kiosk-kicker', kicker), title(heading, 'kiosk-card-title'), el('p', 'kiosk-desc', description));
    header.append(text);
    if (aside) header.append(aside);
    return header;
  }

  // ---------- 1. ticket ----------
  function find(code: string): void {
    try {
      ticket = ops.findTicket(code);
    } catch {
      typed = '';
      return fail('Tiket tidak ditemukan. Cek nomornya, atau minta bantuan petugas.');
    }
    selected.clear();
    for (const face of party()) selected.add(face.id);
    go('faces');
  }

  function scanStep(): HTMLElement[] {
    const how = el('ol', 'kiosk-how');
    for (const [index, line] of ['Pilih siapa saja yang ikut di foto', 'Pilih template yang sudah berisi wajah Anda', 'Bayar dengan QRIS, ambil cetakannya'].entries()) {
      const item = el('li');
      item.append(el('span', 'kiosk-how-number', String(index + 1)), el('span', '', line));
      how.append(item);
    }
    const hero = card(
      'kiosk-hero',
      el('p', 'kiosk-kicker kiosk-kicker--ink', 'Foto AI'),
      title('Foto bareng rombongan', 'kiosk-hero-title'),
      el('p', 'kiosk-hero-desc', 'Wajah rombongan Anda sudah dipotret di gerbang. Tinggal pilih, bayar, dan bawa pulang cetakannya.'),
      how,
      price() ? el('p', 'kiosk-price', `Satu cetakan ${money(price())}`) : null,
    );

    // A USB or camera scanner types the QR's link and presses Enter into this hidden field.
    const form = el('form', 'kiosk-scan');
    const input = el('input', 'kiosk-scan-input');
    input.autocomplete = 'off';
    input.setAttribute('aria-label', 'Kode tiket');
    form.append(input);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      find(input.value);
    });
    queueMicrotask(() => input.focus({ preventScroll: true }));

    const reader = el('div', 'kiosk-reader');
    const rings = el('div', 'kiosk-reader-rings');
    const disc = el('span', 'kiosk-reader-disc');
    disc.append(icon('qr'));
    rings.append(el('span', 'kiosk-ring'), el('span', 'kiosk-ring kiosk-ring--outer'), disc);
    const readerText = el('div');
    readerText.append(el('p', 'kiosk-reader-title', 'Scan QR tiket'), el('p', 'kiosk-desc', 'Dekatkan QR di tiket ke pemindai di bawah layar.'));
    reader.append(rings, readerText);

    const display = el('p', `kiosk-typed${typed ? '' : ' is-empty'}`, typed || 'Nomor tiket');
    display.setAttribute('aria-live', 'polite');
    const letters = el('div', 'kiosk-letters');
    const keys = el('div', 'kiosk-keypad');
    const key = (label: string, run: () => void, className = '', into = keys) => {
      const element = el('button', `kiosk-key ${className}`, label);
      element.type = 'button';
      element.addEventListener('click', run);
      into.append(element);
    };
    const type = (char: string | null) => {
      typed = char === null ? typed.slice(0, -1) : (typed + char).slice(0, 8);
      error = '';
      draw();
    };
    for (const letter of prefixes(ops)) key(letter, () => type(letter), 'kiosk-key--letter', letters);
    for (const digit of ['1', '2', '3', '4', '5', '6', '7', '8', '9']) key(digit, () => type(digit));
    key('Hapus', () => type(null), 'kiosk-key--muted');
    key('0', () => type('0'));
    key('Cari', () => find(typed), 'kiosk-key--go');

    const pad = card('kiosk-card kiosk-pad', banner(), form, reader, el('p', 'kiosk-divider', 'atau ketik nomor tiket'), display, letters.childElementCount ? letters : null, keys);
    return [card('kiosk-split', hero, pad)];
  }

  // ---------- 2. faces ----------
  function facesStep(): HTMLElement[] {
    const faces = party();
    if (faces.length === 0) {
      return [
        card('kiosk-hero kiosk-hero--center', el('p', 'kiosk-kicker kiosk-kicker--ink', `Tiket ${ticket!.number}`), title('Belum ada foto rombongan', 'kiosk-hero-title'), el('p', 'kiosk-hero-desc', 'Kamera gerbang belum memotret rombongan tiket ini. Minta petugas di gerbang memotret rombongan Anda, lalu scan lagi di sini.')),
        bar(button('Kembali ke awal', 'btn-outline btn-xl', restart)),
      ];
    }
    const grid = el('div', 'kiosk-faces');
    for (const face of faces) {
      const on = selected.has(face.id);
      const tile = el('button', `kiosk-face${on ? ' is-selected' : ''}`);
      tile.type = 'button';
      tile.setAttribute('aria-pressed', String(on));
      const img = el('img');
      img.alt = face.name || 'Wajah rombongan';
      void blobUrl(face.image).then((url) => (img.src = url));
      const mark = el('span', 'kiosk-face-mark');
      if (on) mark.append(icon('check'));
      tile.append(img, mark);
      if (face.name) tile.append(el('span', 'kiosk-face-name', face.name));
      tile.addEventListener('click', () => {
        if (on) selected.delete(face.id);
        else selected.add(face.id);
        draw();
      });
      grid.append(tile);
    }
    const all = selected.size === faces.length;
    const toggle = button(all ? 'Batalkan semua' : 'Pilih semua', 'btn-soft btn-lg', () => {
      if (all) selected.clear();
      else for (const face of faces) selected.add(face.id);
      draw();
    });
    const next = button(selected.size ? `Lanjut dengan ${selected.size} orang` : 'Pilih minimal satu orang', 'btn-primary btn-xl', () => {
      go('templates');
      void renderAll();
    });
    next.disabled = selected.size === 0;
    return [
      card('kiosk-card', cardHead(`Rombongan ${ticket!.number}`, 'Siapa saja yang ikut', 'Ketuk wajah untuk memilih atau membatalkan. Semua yang dicentang masuk ke foto.', toggle), banner(), grid),
      bar(button('Batal', 'btn-outline btn-xl', restart), next),
    ];
  }

  // ---------- 3. templates ----------
  async function renderAll(): Promise<void> {
    const token = ++renderToken;
    for (const render of renders) URL.revokeObjectURL(render.url);
    renders = [];
    const faces = await Promise.all(party().filter((face) => selected.has(face.id)).map(faceBitmap));
    for await (const render of fillTemplates(ops, faces)) {
      if (token !== renderToken) return URL.revokeObjectURL(render.url);
      renders.push(render);
      if (step === 'templates') draw();
    }
  }

  function templatesStep(): HTMLElement[] {
    const total = presetTemplates(ops).length;
    const suggested = suggestPreset(presetTemplates(ops), selected.size);
    const grid = el('div', 'kiosk-templates');
    for (const render of renders) {
      const tile = el('button', `kiosk-template${render.preset.id === suggested?.id ? ' is-suggested' : ''}`);
      tile.type = 'button';
      const img = el('img');
      img.src = render.url;
      img.alt = render.preset.name;
      const label = el('span', 'kiosk-template-label');
      label.append(el('span', 'kiosk-template-name', render.preset.name));
      if (render.preset.id === suggested?.id) label.append(el('span', 'kiosk-template-tag', 'Disarankan'));
      tile.append(img, label);
      tile.addEventListener('click', () => {
        chosen = render;
        if (due() > 0) go('pay');
        else void pay();
      });
      grid.append(tile);
    }
    for (let i = renders.length; i < total; i++) grid.append(el('div', 'kiosk-template kiosk-template--loading'));
    const hint = price() ? `Ketuk yang paling Anda suka. Satu cetakan ${money(price())}.` : 'Ketuk yang paling Anda suka.';
    return [
      card('kiosk-card', cardHead(`${selected.size} orang`, 'Pilih template', hint), banner(), grid),
      bar(button('Ganti orang', 'btn-outline btn-xl', () => go('faces'), 'users')),
    ];
  }

  // ---------- 4. pay ----------
  function order() {
    if (orderId) return ops.order(orderId);
    const created = ops.createOrder({
      lines: [{ kind: 'preset', refId: chosen!.preset.id, label: `AI preset · ${chosen!.preset.name}`, unitPrice: price(), qty: 1 }],
      presetId: null,
      voucherCode: voucher?.code ?? '',
      channel: 'booth',
      branchId: ops.branchOf(booth) ?? '',
      boothId: booth,
    });
    orderId = created.id;
    return created;
  }

  /** Free after a voucher: the order closes at once. Otherwise the QRIS callback settles it. */
  async function pay(): Promise<void> {
    if (qr) return;
    if (due() === 0 || order().status === 'paid') {
      order();
      return make();
    }
    const payment = await ops.chargeQris(orderId!);
    qr = payment.qrString ?? '';
    reference = payment.reference;
    error = '';
    stopWatching?.();
    stopWatching = ops.store.subscribe(() => {
      if (step === 'pay' && orderId && amountDue(ops.order(orderId)) === 0) {
        stopWatching?.();
        stopWatching = null;
        void make();
      }
    });
    draw();
  }

  function summary(): HTMLElement {
    const thumb = el('img', 'kiosk-summary-image');
    thumb.src = chosen!.url;
    thumb.alt = chosen!.preset.name;
    const lines = el('dl', 'kiosk-lines');
    lines.append(el('dt', '', chosen!.preset.name), el('dd', '', money(price())));
    if (discount) lines.append(el('dt', '', `Voucher ${voucher!.code}`), el('dd', '', `−${money(discount)}`));
    const total = el('div', 'kiosk-total');
    total.append(el('span', 'kiosk-kicker kiosk-kicker--ink', 'Total'), el('span', 'kiosk-total-value', money(due())));
    return card('kiosk-hero kiosk-summary', thumb, lines, total);
  }

  function payStep(): HTMLElement[] {
    const back = button('Template lain', 'btn-outline btn-xl', () => {
      dropOrder();
      go('templates');
    }, 'frame');

    if (qr) {
      const area = el('div', 'kiosk-qris');
      const frame = el('div', 'kiosk-qris-frame');
      frame.append(qrCanvas(qr, 360));
      area.append(frame);
      const payment = ops.order(orderId!).payments.find((entry) => entry.reference === reference);
      if (payment) {
        area.append(qrClock(ops, orderId!, payment.id, (status) => {
          if (status === 'paid') return;
          qr = '';
          reference = '';
          fail(status === 'expired' ? 'Waktu QR habis. Ketuk Bayar untuk QR baru.' : 'QR dibatalkan. Ketuk Bayar untuk QR baru.');
        }, (time) => `Berlaku ${time}`));
      }
      const waiting = el('p', 'kiosk-waiting');
      waiting.append(el('span', 'kiosk-live-dot'), el('span', '', 'Menunggu pembayaran. Cetakan keluar otomatis.'));
      area.append(waiting);
      if (ops.gateway.simulated) area.append(button('Simulasi bayar (uji coba)', 'btn-ghost btn-lg', () => ops.gateway.simulatePaid!(reference)));
      const right = card('kiosk-card kiosk-pay', cardHead(`QRIS · ${ops.gateway.label}`, 'Scan untuk bayar', 'Pakai aplikasi bank atau e-wallet apa saja.'), banner(), area);
      return [card('kiosk-split', summary(), right), bar(back)];
    }

    const code = el('input', 'input kiosk-input');
    code.placeholder = 'Kode voucher';
    code.autocomplete = 'off';
    code.setAttribute('aria-label', 'Kode voucher');
    const voucherRow = el('div', 'kiosk-voucher');
    voucherRow.append(code, button('Pakai', 'btn-soft btn-xl', () => {
      if (!code.value.trim()) throw new Error('Ketik kode voucher dulu.');
      try {
        ({ voucher, discount } = ops.redeemAtBooth(code.value, booth, price()));
      } catch {
        throw new Error('Kode voucher tidak berlaku di booth ini.');
      }
      draw();
    }));

    const qrisAllowed = methodAllowed(ops.payments, 'qris', 'booth');
    const next = due() === 0
      ? button('Cetak sekarang', 'btn-primary btn-xl', pay, 'printer')
      : qrisAllowed
        ? button(`Bayar ${money(due())}`, 'btn-primary btn-xl', pay, 'qr')
        : null;
    const methods = el('div', 'kiosk-method');
    const tile = el('span', 'kiosk-method-icon');
    tile.append(icon('qr'));
    const methodText = el('div');
    methodText.append(el('p', 'kiosk-method-title', 'QRIS'), el('p', 'kiosk-desc', qrisAllowed ? 'Semua aplikasi bank dan e-wallet' : 'Belum aktif di booth ini. Bayar di kasir, lalu ketik kode dari struk di kolom voucher.'));
    methods.append(tile, methodText);
    const right = card('kiosk-card kiosk-pay', cardHead('Pembayaran', 'Cara bayar', 'Bayar dengan QRIS, atau pakai voucher atau kode dari struk kasir.'), banner(), methods, el('p', 'kiosk-divider', 'punya voucher?'), voucherRow);
    return [card('kiosk-split', summary(), right), next ? bar(back, next) : bar(back)];
  }

  // ---------- 5. making and printing ----------
  /** The AI redraws the template when this window holds a Decart key; the template prints as it is otherwise. */
  async function make(): Promise<void> {
    if (step === 'making' || step === 'done') return;
    go('making');
    let image = await canvasToBlob(chosen!.canvas, 'image/jpeg', 0.92);
    const key = readStoredKey();
    if (key) {
      try {
        image = await restylePreset(key, image, chosen!.preset.prompt);
      } catch (reason) {
        console.warn('AI redraw failed, printing the template', reason);
      }
    }
    const number = orderId ? ops.order(orderId).number : '';
    try {
      await ops.print(booth, image, ops.printSizeFor(booth), 1);
      result = `Ambil foto Anda di printer.${number ? ` Nomor pesanan ${number}.` : ''}`;
    } catch {
      result = `Foto Anda sudah jadi, tapi printer belum siap. Tunjukkan nomor pesanan${number ? ` ${number}` : ''} ke petugas.`;
    }
    orderId = null;
    go('done');
  }

  function finale(heading: string, description: string, working: boolean, ...extra: HTMLElement[]): HTMLElement {
    const preview = el('img', `kiosk-final-image${working ? ' is-working' : ''}`);
    preview.src = chosen!.url;
    preview.alt = chosen!.preset.name;
    const text = el('div', 'kiosk-final-text');
    text.append(el('p', 'kiosk-kicker kiosk-kicker--ink', working ? 'Sedang diproses' : 'Selesai'), title(heading, 'kiosk-hero-title'), el('p', 'kiosk-hero-desc', description), ...extra);
    return card('kiosk-hero kiosk-final', preview, text);
  }

  function makingStep(): HTMLElement[] {
    const working = el('p', 'kiosk-waiting kiosk-waiting--ink');
    working.append(el('span', 'kiosk-live-dot'), el('span', '', readStoredKey() ? 'AI sedang menggambar ulang' : 'Mengirim ke printer'));
    return [finale('Sedang dibuat', readStoredKey() ? 'AI sedang menggambar ulang foto Anda, lalu langsung dicetak. Mohon tunggu sebentar.' : 'Foto Anda sedang dikirim ke printer.', true, working)];
  }

  function doneStep(): HTMLElement[] {
    return [
      finale('Terima kasih', result, false, el('p', 'kiosk-note', 'Layar kembali ke awal sebentar lagi.')),
      bar(button('Selesai', 'btn-primary btn-xl', restart, 'check')),
    ];
  }

  function drawProgress(): void {
    const at = STEPS.findIndex((entry) => entry.step === (step === 'making' ? 'done' : step));
    progress.replaceChildren();
    for (const [index, { label }] of STEPS.entries()) {
      const item = el('li', index < at ? 'is-done' : index === at ? 'is-active' : '');
      const mark = el('span', 'kiosk-step-mark');
      if (index < at) mark.append(icon('check'));
      else mark.textContent = String(index + 1);
      item.append(mark, el('span', 'kiosk-step-label', label));
      if (index === at) item.setAttribute('aria-current', 'step');
      progress.append(item);
    }
  }

  function draw(): void {
    const steps: Record<Step, () => HTMLElement[]> = { scan: scanStep, faces: facesStep, templates: templatesStep, pay: payStep, making: makingStep, done: doneStep };
    drawProgress();
    root.replaceChildren(...steps[step]());
  }

  // Faces arriving from the gate while the party picks show up at once.
  ops.store.subscribe(() => {
    if (step === 'faces') draw();
  });
  draw();
}
