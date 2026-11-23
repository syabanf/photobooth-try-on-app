// The till: one cart of sessions, prints, merchandise and paid reprints; cash, QRIS, card or
// e-wallet; a receipt with the session codes and queue number; shifts and the customer screen.

import { formDialog, openDialog } from '../../../dialogs';
import { SHOT_LABELS, listShots, type Shot } from '../../../gallery';
import { icon, iconButton, type IconName } from '../../../icons';
import { printDocument, printImage } from '../../adapters';
import { amountDue, lineGross } from '../../cart';
import { PAYMENT_LABELS, SESSION_MODES, type Order, type PaperSize, type Payment, type PaymentMethod, type SessionMode } from '../../model';
import { readQris } from '../../encoders';
import { allowedMethods, payable } from '../../payments';
import { markPaidDialog } from './payments';
import type { CartLine, Ops } from '../../ops';
import { PAPER } from '../../printing';
import { shiftSlip, type ShiftSlip } from '../../shift';
import type { PageContext } from '../router';
import { act, actionButton, badge, dateTime, el, money, notice, page, parseAmount, pills, qrCanvas } from '../kit';
import { displayChannel } from '../display-route';

type Tab = 'sessions' | 'prints' | 'merch' | 'reprint';

const cart = {
  lines: [] as CartLine[],
  presetId: null as string | null,
  voucherCode: '',
  email: '',
  branchId: '',
  tab: 'sessions' as Tab,
};

let reprintShots: Shot[] | null = null;
const thumbs = new Map<string, string>();
const thumb = (shot: Shot) => thumbs.get(shot.id) ?? (thumbs.set(shot.id, URL.createObjectURL(shot.blob)), thumbs.get(shot.id)!);

let lastCart = '';

function broadcast(ops: Ops, message: unknown): void {
  displayChannel(ops)?.postMessage(message);
}

/** Sends the cart to the customer screen only when it changed, so "Thank you" stays up after a sale. */
function broadcastCart(ops: Ops, message: unknown): void {
  const text = JSON.stringify(message);
  if (text === lastCart) return;
  lastCart = text;
  broadcast(ops, message);
}

function addLine(line: CartLine): void {
  const same = cart.lines.find((entry) => entry.kind === line.kind && entry.refId === line.refId && entry.mode === line.mode && entry.size === line.size && line.kind !== 'reprint');
  if (same) same.qty += 1;
  else cart.lines.push(line);
}

/** One picture per session mode, so the cashier finds it without reading. */
const MODE_ICONS: Record<SessionMode, IconName> = { strip: 'strip', gif: 'repeat', video: 'video', live: 'play', vintage: 'film' };

export function renderPos(context: PageContext): HTMLElement {
  const { ops, redraw } = context;
  const { state } = ops;
  const branches = ops.visibleBranches();
  if (!branches.some((branch) => branch.id === cart.branchId)) cart.branchId = ops.branchOf(ops.hooks.devicePointId()) ?? branches[0]?.id ?? '';
  const view = page('Kasir', 'Jual sesi, cetakan dan merchandise dalam satu keranjang. Sesi yang lunas mendapat kode dan nomor antrean di struk.');

  if (branches.length === 0) {
    view.body.append(el('p', 'card-desc', 'Tambahkan lokasi dan booth-nya dulu di halaman Lokasi.'));
    return view.root;
  }

  // ---------- shift bar ----------
  const shift = ops.openShiftFor(cart.branchId);
  const bar = el('div', 'pos-bar');
  const branchPick = el('select', 'input select pos-branch');
  for (const branch of branches) branchPick.add(new Option(branch.name, branch.id, false, branch.id === cart.branchId));
  branchPick.addEventListener('change', () => {
    cart.branchId = branchPick.value;
    redraw();
  });
  const shiftText = el('p', 'pos-shift');
  if (shift) {
    const person = state.staff.find((entry) => entry.id === shift.staffId)?.name ?? 'seseorang';
    shiftText.append(badge('Shift buka', 'ok'), ` sejak ${new Date(shift.openedAt).toLocaleTimeString('id-ID', { timeStyle: 'short' })} oleh ${person}`);
  } else {
    shiftText.append(badge(state.settings.shiftsEnabled ? 'Belum ada shift' : 'Shift mati', state.settings.shiftsEnabled ? 'warn' : 'muted'));
  }
  bar.append(branchPick, shiftText);
  if (shift) bar.append(act('Tutup shift', 'btn btn-outline btn-sm', () => closeShiftDialog(ops, shift.id)));
  bar.append(act('Layar pelanggan', 'btn btn-ghost btn-sm', () => window.open(`${location.pathname}#display=customer&lock=1`, 'vto-customer', 'popup,width=900,height=640'), 'tv'));
  view.actions.append(bar);
  // Nothing sells before a shift opens, so the till asks for one before it shows anything to sell.
  if (!shift && state.settings.shiftsEnabled) {
    view.body.append(openShiftPanel(context));
    return view.root;
  }

  // ---------- catalogue ----------
  const layout = el('div', 'pos-layout');
  const catalogue = el('section', 'pos-catalogue');
  catalogue.append(
    pills(
      [
        { value: 'sessions', label: 'Sesi' },
        { value: 'prints', label: 'Cetak' },
        { value: 'merch', label: 'Merchandise' },
        { value: 'reprint', label: 'Cetak ulang' },
      ] as const,
      cart.tab,
      (tab) => {
        cart.tab = tab;
        redraw();
      },
    ),
  );
  const grid = el('div', 'pos-grid');
  const tile = (title: string, meta: string, price: number, onAdd: () => void, disabled = false, iconName: IconName = 'package') => {
    const button = el('button', 'pos-tile');
    button.type = 'button';
    button.disabled = disabled;
    button.append(icon(iconName), el('span', 'pos-tile-title', title));
    if (meta) button.append(el('span', 'pos-tile-meta', meta));
    button.append(el('span', 'pos-tile-price', money(price)));
    button.addEventListener('click', () => {
      onAdd();
      redraw();
    });
    return button;
  };

  if (cart.tab === 'sessions') {
    for (const category of state.categories) {
      for (const mode of Object.keys(SESSION_MODES) as SessionMode[]) {
        const price = category.prices[mode];
        if (price === undefined) continue;
        const meta = state.categories.length > 1 ? category.name : '';
        grid.append(tile(SESSION_MODES[mode].label, meta, price, () => addLine({ kind: 'session', refId: category.id, label: `${category.name} · ${SESSION_MODES[mode].label}`, unitPrice: price, qty: 1, mode }), false, MODE_ICONS[mode]));
      }
    }
  } else if (cart.tab === 'prints') {
    for (const entry of state.printPrices) grid.append(tile(`Cetak ${entry.size}`, PAPER[entry.size].label.split(' · ')[1] ?? '', entry.price, () => addLine({ kind: 'print', refId: entry.size, label: `Cetakan tambahan ${entry.size}`, unitPrice: entry.price, qty: 1, size: entry.size }), false, 'printer'));
  } else if (cart.tab === 'merch') {
    if (state.products.length === 0) grid.append(el('p', 'card-desc', 'Tambahkan merchandise di Pengaturan.'));
    for (const product of state.products) {
      const inCart = cart.lines.filter((line) => line.refId === product.id).reduce((sum, line) => sum + line.qty, 0);
      grid.append(tile(product.name, product.stock - inCart > 0 ? `sisa ${product.stock - inCart}` : 'Habis', product.price, () => addLine({ kind: 'merch', refId: product.id, label: product.name, unitPrice: product.price, qty: 1 }), product.stock - inCart <= 0));
    }
  } else {
    if (!reprintShots) void listShots().then((shots) => {
      reprintShots = shots.filter((shot) => shot.blob.type.startsWith('image/'));
      redraw();
    });
    const size = state.printPrices[0];
    if (!size) grid.append(el('p', 'card-desc', 'Tambahkan harga cetak di Pengaturan dulu.'));
    for (const shot of (reprintShots ?? []).slice(0, 24)) {
      const button = el('button', 'pos-tile pos-shot');
      button.type = 'button';
      const img = el('img');
      img.src = thumb(shot);
      img.alt = SHOT_LABELS[shot.kind];
      button.append(img, el('span', 'pos-tile-meta', dateTime(shot.createdAt)));
      button.disabled = !size;
      button.addEventListener('click', () => {
        addLine({ kind: 'reprint', refId: shot.id, label: `Cetak ulang ${size.size} · ${SHOT_LABELS[shot.kind]}`, unitPrice: size.price, qty: 1, size: size.size });
        redraw();
      });
      grid.append(button);
    }
  }
  catalogue.append(grid);

  // ---------- cart ----------
  const quote = ops.quote(cart.lines, cart.presetId, cart.voucherCode, null);
  const cartBox = el('section', 'pos-cart');
  cartBox.append(el('h3', 'ops-section-title', 'Keranjang'));
  const list = el('div', 'cart-lines');
  if (cart.lines.length === 0) list.append(el('p', 'card-desc', 'Ketuk item untuk menambahkannya.'));
  cart.lines.forEach((line, index) => {
    const row = el('div', 'cart-line');
    const text = el('div', 'cart-text');
    text.append(el('span', 'rank-name', line.label), el('span', 'rank-meta', `${money(line.unitPrice)} per item`));
    const minus = iconButton('minus', 'Kurangi satu');
    minus.addEventListener('click', () => {
      line.qty -= 1;
      if (line.qty <= 0) cart.lines.splice(index, 1);
      redraw();
    });
    const plus = iconButton('plus', 'Tambah satu');
    plus.addEventListener('click', () => {
      line.qty += 1;
      redraw();
    });
    row.append(text, minus, el('span', 'cart-qty', String(line.qty)), plus, el('span', 'cart-amount', money(lineGross(line))));
    list.append(row);
  });

  const extras = el('div', 'cart-extras');
  if (state.presets.length && ops.can('pos.discount')) {
    extras.append(
      pills([{ value: '', label: 'Tanpa diskon' }, ...state.presets.map((preset) => ({ value: preset.id, label: preset.name }))], cart.presetId ?? '', (value) => {
        cart.presetId = value || null;
        redraw();
      }),
    );
  }
  const voucher = el('input', 'input');
  voucher.placeholder = 'Kode voucher';
  voucher.value = cart.voucherCode;
  voucher.addEventListener('change', () => {
    cart.voucherCode = voucher.value.trim().toUpperCase();
    redraw();
  });
  const email = el('input', 'input');
  email.type = 'email';
  email.placeholder = 'Email pelanggan untuk struk (opsional)';
  email.value = cart.email;
  email.addEventListener('change', () => (cart.email = email.value.trim()));
  extras.append(voucher);
  if (quote.voucherError) extras.append(el('p', 'field-error', quote.voucherError));
  else if (quote.voucher) extras.append(el('p', 'field-hint', `${quote.voucher.code} dipakai untuk sesi.`));
  extras.append(email);

  const totals = el('dl', 'cart-totals');
  totals.append(el('dt', '', 'Subtotal'), el('dd', '', money(quote.subtotal)));
  if (quote.discount) totals.append(el('dt', '', 'Diskon'), el('dd', '', `−${money(quote.discount)}`));
  totals.append(el('dt', 'cart-total-label', 'Total'), el('dd', 'cart-total', money(quote.total)));

  const charge = actionButton(`Bayar ${money(quote.total)}`, 'btn btn-primary btn-lg btn-block');
  charge.disabled = cart.lines.length === 0 || !!quote.voucherError;
  charge.addEventListener('click', () => {
    try {
      const order = ops.createOrder({ lines: cart.lines, presetId: cart.presetId, voucherCode: cart.voucherCode, channel: 'cashier', branchId: cart.branchId, boothId: null, customerEmail: cart.email });
      if (order.status === 'paid') finish(context, order);
      else paymentDialog(context, order.id);
    } catch (error) {
      notice((error as Error).message, 'error');
    }
  });
  const clear = act('Kosongkan', 'btn btn-ghost btn-block', () => {
    Object.assign(cart, { lines: [], presetId: null, voucherCode: '', email: '' });
    redraw();
  });
  cartBox.append(list, extras, totals, charge, clear);
  broadcastCart(ops, { type: 'cart', lines: cart.lines.map((line) => ({ label: line.label, qty: line.qty, amount: lineGross(line) })), discount: quote.discount, total: quote.total });

  layout.append(catalogue, cartBox);
  view.body.append(layout);
  return view.root;
}

const HELP_AFTER_MS = 45_000;
const QUIET_WARN_MS = 30 * 60_000;

/**
 * What a customer needs beside a shop-QRIS code: the exact amount when it differs from the order
 * (a unique code) or has to be typed, the name their app will show, and, after a while with no
 * payment seen, what to do. Null for a gateway QR, which needs none of it.
 */
export function qrExact(ops: Ops, payment: Payment, { bahasa = false, showAmount = true } = {}): HTMLElement | null {
  const { provider, lockAmount, staticQris } = ops.payments.gateway;
  if (provider !== 'static') return null;
  const code = payment.uniqueCode ?? 0;
  const box = el('div', 'qr-exact');
  if (code || !lockAmount) {
    const notes = bahasa
      ? [lockAmount ? '' : 'Ketik nominal ini persis di aplikasi Anda.', code ? `${money(payment.amount)} + kode unik ${money(code)}, supaya pembayaran Anda langsung dikenali.` : '']
      : [lockAmount ? '' : 'Ketik nominal ini persis di aplikasi pelanggan.', code ? `${money(payment.amount)} ditambah kode unik ${money(code)}, supaya pembayaran ini langsung dikenali.` : ''];
    if (showAmount) box.append(el('p', 'qr-exact-label', 'Bayar tepat'), el('p', 'qr-exact-amount', money(payable(payment))));
    box.append(el('p', 'card-desc', notes.filter(Boolean).join(' ')));
  }
  box.append(el('p', 'card-desc', `${bahasa ? 'Nama penerima di aplikasi Anda' : 'Nama penerima di aplikasi'}: ${readQris(staticQris).merchantName}`));
  const help = el('p', 'qr-exact-help', bahasa ? 'Sudah bayar tetapi layar belum berubah? Tunjukkan bukti bayar ke petugas.' : 'Sudah bayar tetapi layar belum berubah? Minta pelanggan menunjukkan bukti bayar.');
  help.hidden = true;
  box.append(help);
  setTimeout(() => (help.hidden = false), HELP_AFTER_MS);
  return box;
}

/** For staff: whether the phone that reports shop-QRIS payments is still reaching the booth computer. */
function phoneLink(ops: Ops): HTMLElement {
  const line = el('p', 'card-desc phone-link');
  const tick = () => {
    if (!line.isConnected && line.textContent) return clearInterval(timer);
    const quiet = ops.gateway.phoneQuietMs?.();
    const minutes = Math.round((quiet ?? 0) / 60_000);
    const stale = quiet === null || (quiet !== undefined && quiet > QUIET_WARN_MS);
    line.classList.toggle('is-warn', stale);
    line.textContent =
      quiet === undefined ? 'Memeriksa ponsel penerus notifikasi…'
      : quiet === null ? 'Ponsel penerus notifikasi belum pernah terhubung ke komputer booth. Selesaikan pembayaran ini dengan Tandai lunas manual.'
      : stale ? `Ponsel penerus notifikasi tidak mengirim kabar selama ${minutes >= 120 ? `${Math.round(minutes / 60)} jam` : `${minutes} menit`}. Kalau pembayaran ini tidak lunas sendiri, periksa ponselnya atau tandai lunas manual.`
      : `Kabar terakhir dari ponsel penerus: ${minutes < 1 ? 'baru saja' : `${minutes} menit lalu`}.`;
  };
  const timer = setInterval(tick, 3_000);
  tick();
  return line;
}

/** "Valid for 14:59", counting down, or the state the QR ended in. */
export function qrClock(ops: Ops, orderId: string, paymentId: string, onEnd: (status: Payment['status']) => void, label = (time: string) => `Berlaku ${time} lagi`): HTMLElement {
  const line = el('p', 'card-desc qr-clock');
  const tick = () => {
    const payment = ops.order(orderId).payments.find((entry) => entry.id === paymentId);
    if (!payment) return;
    if (payment.status !== 'pending') {
      clearInterval(timer);
      onEnd(payment.status);
      return;
    }
    const left = Math.max(0, (payment.expiresAt ?? 0) - Date.now());
    if (left === 0) ops.expirePayments();
    const minutes = Math.floor(left / 60_000);
    const seconds = Math.floor((left % 60_000) / 1000);
    line.textContent = label(`${minutes}:${String(seconds).padStart(2, '0')}`);
  };
  const timer = setInterval(tick, 1000);
  tick();
  return line;
}

function paymentDialog(context: PageContext, orderId: string): void {
  const { ops } = context;
  const methods = allowedMethods(ops.payments, 'cashier');
  let method: PaymentMethod = methods[0] ?? 'cash';
  const body = el('div', 'pay-body');
  const error = el('p', 'field-error');
  error.hidden = true;
  let stop: (() => void) | null = null;

  const done = (order: Order) => {
    stop?.();
    dialog.close();
    finish(context, order);
  };

  function draw(): void {
    const order = ops.order(orderId);
    const due = amountDue(order);
    const dueLine = el('p', 'pay-due', money(due));
    body.replaceChildren(
      dueLine,
      el('p', 'card-desc', `${order.number} · ${order.lines.length} item`),
      pills(methods.map((value) => ({ value, label: PAYMENT_LABELS[value] })), method, (value) => {
        method = value;
        draw();
      }),
    );
    error.hidden = true;
    if (methods.length === 0) {
      body.append(el('p', 'field-error', 'Semua metode bayar dimatikan untuk kasir. Nyalakan salah satu di Pembayaran → Metode dan biaya.'));
      return;
    }
    if (method === 'cash') {
      const tendered = el('input', 'input pay-input');
      tendered.inputMode = 'numeric';
      tendered.placeholder = 'Uang diterima';
      const quick = el('div', 'pay-quick');
      for (const amount of [...new Set([due, Math.ceil(due / 50_000) * 50_000, Math.ceil(due / 100_000) * 100_000])]) {
        const button = actionButton(money(amount), 'btn btn-outline btn-sm');
        button.addEventListener('click', () => (tendered.value = String(amount)));
        quick.append(button);
      }
      const take = actionButton('Terima tunai', 'btn btn-primary btn-block');
      take.addEventListener('click', () => {
        try {
          const change = ops.pay(orderId, 'cash', parseAmount(tendered.value));
          const after = ops.order(orderId);
          // A part payment stays open; the paid screen shows the change of a full one.
          if (change && after.status !== 'paid') notice(`Kembalian: ${money(change)}`, 'ok');
          if (after.status === 'paid') done(after);
          else draw();
        } catch (e) {
          error.textContent = (e as Error).message;
          error.hidden = false;
        }
      });
      body.append(tendered, quick, take);
      tendered.focus();
    } else if (method === 'qris') {
      const area = el('div', 'pay-qris');
      body.append(area);
      area.append(el('p', 'card-desc', 'Membuat QR…'));
      void ops.chargeQris(orderId).then((payment) => {
        const ended = (status: Payment['status']) => {
          if (status === 'paid') return;
          const again = actionButton('QR baru', 'btn btn-primary btn-sm');
          again.addEventListener('click', draw);
          area.replaceChildren(el('p', 'field-error', status === 'expired' ? 'QR ini sudah kedaluwarsa.' : 'QR ini dibatalkan.'), again);
        };
        area.replaceChildren(
          qrCanvas(payment.qrString ?? '', 240),
          ...[qrExact(ops, payment, { showAmount: false })].filter((node) => node !== null),
          el('p', 'card-desc', `Pindai dengan aplikasi bank atau e-wallet apa saja. ${payment.gateway} · ${payment.reference}`),
          qrClock(ops, orderId, payment.id, ended),
        );
        broadcast(ops, { type: 'qris', qr: payment.qrString, amount: payable(payment), reference: payment.reference });
        // No gateway calls back for a static QRIS: when the phone's notification never arrives,
        // a supervisor settles it here from what the bank app shows.
        if (ops.payments.gateway.provider === 'static') {
          // One amount on the screen: what the customer pays, unique code included.
          dueLine.textContent = money(payable(payment));
          area.append(phoneLink(ops), act('Tandai lunas manual', 'btn btn-ghost btn-sm', () => markPaidDialog(ops, orderId, payment.id)));
        }
        if (ops.gateway.simulated) {
          const simulate = actionButton('Simulasikan pembayaran', 'btn btn-outline btn-sm');
          simulate.addEventListener('click', () => ops.gateway.simulatePaid!(payment.reference));
          area.append(badge('Simulator: tidak ada uang yang berpindah', 'warn'), simulate);
        }
        stop?.();
        stop = ops.store.subscribe(() => {
          const now = ops.order(orderId);
          if (now.status === 'paid') done(now);
        });
      }, (e) => {
        area.replaceChildren(el('p', 'field-error', (e as Error).message));
      });
    } else {
      // Card payments name the terminal that took them; e-wallet payments name the wallet.
      const choices = method === 'card' ? ops.payments.terminals.filter((terminal) => terminal.branchId === order.branchId).map((terminal) => ({ value: terminal.id, label: terminal.name })) : ops.payments.wallets.map((wallet) => ({ value: wallet, label: wallet }));
      let picked = choices[0]?.value ?? '';
      if (choices.length) body.append(pills(choices, picked, (value) => (picked = value)));
      const reference = el('input', 'input pay-input');
      reference.placeholder = method === 'card' ? 'Kode approval EDC' : 'Referensi e-wallet';
      const take = actionButton(`Catat pembayaran ${PAYMENT_LABELS[method]}`, 'btn btn-primary btn-block');
      take.addEventListener('click', () => {
        try {
          ops.pay(orderId, method as 'card' | 'ewallet', due, reference.value, method === 'card' ? { terminalId: picked || undefined } : { wallet: picked || undefined });
          done(ops.order(orderId));
        } catch (e) {
          error.textContent = (e as Error).message;
          error.hidden = false;
        }
      });
      body.append(reference, take);
      reference.focus();
    }
    body.append(error);
  }

  const cancel = actionButton('Batalkan pesanan', 'btn btn-ghost btn-danger');
  cancel.addEventListener('click', () => {
    try {
      ops.cancelOrder(orderId);
      stop?.();
      dialog.close();
      broadcast(ops, { type: 'idle' });
    } catch (e) {
      error.textContent = (e as Error).message;
      error.hidden = false;
    }
  });
  const dialog = openDialog({ title: 'Pembayaran', body: [body], footer: [cancel] });
  draw();
}

/** The till before a shift: count the drawer, then sell. Quick amounts cover the usual floats. */
function openShiftPanel(context: PageContext): HTMLElement {
  const { ops, redraw } = context;
  const panel = el('section', 'pos-start');
  const cash = el('input', 'input pay-input');
  cash.inputMode = 'numeric';
  cash.placeholder = money(0);
  cash.setAttribute('aria-label', 'Modal awal');
  cash.addEventListener('input', () => {
    const amount = parseAmount(cash.value);
    cash.value = amount ? money(amount) : '';
  });
  const quick = el('div', 'pay-quick');
  for (const amount of [0, 100_000, 200_000, 500_000]) {
    const button = actionButton(money(amount), 'btn btn-outline');
    button.addEventListener('click', () => (cash.value = money(amount)));
    quick.append(button);
  }
  const error = el('p', 'field-error');
  error.hidden = true;
  const open = actionButton('Buka shift', 'btn btn-primary btn-lg btn-block');
  open.addEventListener('click', () => {
    try {
      ops.openShift(cart.branchId, parseAmount(cash.value));
      redraw();
    } catch (e) {
      error.textContent = (e as Error).message;
      error.hidden = false;
    }
  });
  panel.append(el('h3', 'pos-start-title', 'Buka shift untuk mulai berjualan'), el('p', 'card-desc', 'Hitung uang di laci, ketik jumlahnya di sini, lalu buka shift.'), cash, quick, error, open);
  return panel;
}

/** After payment: the receipt, its codes and queue number, reprints, and a fresh cart. */
function finish(context: PageContext, order: Order): void {
  const { ops } = context;
  Object.assign(cart, { lines: [], presetId: null, voucherCode: '', email: '' });
  reprintShots = null;
  broadcast(ops, { type: 'paid', number: order.number, tickets: order.ticketNumbers, total: order.total });
  // The empty cart that follows a sale should not replace the thank-you screen.
  lastCart = JSON.stringify({ type: 'cart', lines: [], discount: 0, total: 0 });
  void printReprints(ops, order);

  const body = el('div', 'receipt-summary');
  // The cashier reads the change off this screen while counting it out, so it is the biggest line.
  const change = order.payments.reduce((sum, p) => sum + (p.status === 'paid' && p.method === 'cash' && p.tendered ? Math.max(0, p.tendered - p.amount) : 0), 0);
  if (change) {
    const box = el('div', 'receipt-change');
    box.append(el('span', 'kicker', 'Kembalian'), el('strong', 'receipt-change-amount', money(change)));
    body.append(box);
  }
  body.append(el('p', 'pay-due', money(order.total)), el('p', 'card-desc', `${order.number} lunas dengan ${order.payments.filter((p) => p.status === 'paid').map((p) => PAYMENT_LABELS[p.method]).join(' + ')}`));
  if (order.ticketNumbers.length) body.append(el('p', 'receipt-queue', `Antrean ${order.ticketNumbers.join(', ')}`));
  if (order.sessionVouchers.length) {
    const codes = el('div', 'receipt-codes');
    for (const code of order.sessionVouchers) codes.append(el('span', 'code receipt-code', code));
    body.append(el('p', 'kicker', 'Kode sesi, satu per sesi'), codes);
  }
  const printButton = act('Cetak struk', 'btn btn-outline', () => printReceipt(ops, order), 'printer');
  const emailButton = act('Kirim struk', 'btn btn-outline', () => {
    if (!order.customerEmail) throw new Error('Pesanan ini tidak punya email.');
    ops.edit('pos.sell', 'receipt.email', `Struk ${order.number} dikirim lewat email.`, (draft) => {
      draft.notifications.unshift({ id: ops.store.id(), channel: 'email', to: order.customerEmail, subject: `Struk ${order.number}`, body: receiptText(ops, order), at: Date.now() });
    });
    notice(`Struk akan dikirim ke ${order.customerEmail}.`, 'ok');
  }, 'mail');
  const next = actionButton('Penjualan baru', 'btn btn-primary');
  next.dataset.close = '';
  openDialog({ title: 'Lunas', body: [body], footer: [printButton, emailButton, next] });
  context.redraw();
}

async function printReprints(ops: Ops, order: Order): Promise<void> {
  const lines = order.lines.filter((line) => line.kind === 'reprint');
  if (lines.length === 0) return;
  const shots = await listShots();
  for (const line of lines) {
    const shot = shots.find((entry) => entry.id === line.refId);
    if (!shot) continue;
    const booth = ops.hooks.devicePointId();
    try {
      if (booth) await ops.print(booth, shot.blob, line.size as PaperSize, line.qty);
      else await printImage(shot.blob, { size: line.size as PaperSize, copies: line.qty });
    } catch (error) {
      notice((error as Error).message, 'error');
    }
  }
}

function receiptText(ops: Ops, order: Order): string {
  const lines = order.lines.map((line) => `${line.qty}× ${line.label}  ${money(lineGross(line))}`);
  return [
    ops.state.branding.brandName || ops.account.business,
    ops.branchName(order.branchId),
    `${order.number} · ${dateTime(order.paidAt ?? order.createdAt)}`,
    '',
    ...lines,
    order.discount ? `Diskon  −${money(order.discount)}` : '',
    `Total  ${money(order.total)}`,
    ...order.payments.filter((p) => p.status === 'paid').map((p) => `${PAYMENT_LABELS[p.method]}  ${money(p.tendered ?? p.amount)}${p.tendered && p.tendered > p.amount ? `  kembalian ${money(p.tendered - p.amount)}` : ''}`),
    '',
    order.ticketNumbers.length ? `Nomor antrean: ${order.ticketNumbers.join(', ')}` : '',
    ...order.sessionVouchers.map((code) => `Kode sesi: ${code}`),
    '',
    ops.state.settings.receiptFooter,
  ]
    .filter((line, index, all) => line !== '' || all[index - 1] !== '')
    .join('\n');
}

/** An 80 mm thermal receipt. */
export function printReceipt(ops: Ops, order: Order): Promise<void> {
  return printDocument('@page { size: 80mm auto; margin: 4mm } body { font: 12px/1.45 ui-monospace, Menlo, monospace; white-space: pre-wrap; margin: 0 }', (doc) => {
    doc.body.textContent = receiptText(ops, order);
  });
}

function closeShiftDialog(ops: Ops, shiftId: string): void {
  const shift = ops.state.shifts.find((entry) => entry.id === shiftId)!;
  const preview = shiftSlip(shift, ops.state.orders, ops.state.refunds);
  formDialog({
    title: 'Tutup shift',
    description: `Seharusnya di laci: ${money(preview.expectedCash)} (modal awal ${money(preview.openingCash)} + tunai ${money(preview.byMethod.cash)} − refund tunai ${money(preview.refundsByMethod.cash)}).`,
    submitLabel: 'Tutup shift',
    fields: [{ name: 'counted', label: 'Uang di laci', value: '', type: 'number' }],
    async submit(values) {
      const slip = ops.closeShift(shiftId, parseAmount(String(values.counted)));
      setTimeout(() => showSlip(ops, slip, shiftId));
    },
  });
}

function slipRows(slip: ShiftSlip): [string, string][] {
  return [
    ['Pesanan', String(slip.orders)],
    ['Kotor', money(slip.gross)],
    ['Refund', `−${money(slip.refunds)}`],
    ['Bersih', money(slip.net)],
    ...(['cash', 'qris', 'card', 'ewallet'] as PaymentMethod[]).map((method): [string, string] => [PAYMENT_LABELS[method], money(slip.byMethod[method] - slip.refundsByMethod[method])]),
    ['Modal awal', money(slip.openingCash)],
    ['Tunai seharusnya', money(slip.expectedCash)],
    ['Uang di laci', slip.countedCash === null ? '—' : money(slip.countedCash)],
    ['Selisih', slip.variance === null ? '—' : `${slip.variance > 0 ? '+' : ''}${money(slip.variance)}`],
  ];
}

export function showSlip(ops: Ops, slip: ShiftSlip, shiftId: string): void {
  const facts = el('dl', 'facts');
  for (const [label, value] of slipRows(slip)) facts.append(el('dt', '', label), el('dd', '', value));
  const shift = ops.state.shifts.find((entry) => entry.id === shiftId)!;
  const print = act('Cetak slip', 'btn btn-outline', () =>
    printDocument('@page { size: 80mm auto; margin: 4mm } body { font: 12px/1.5 ui-monospace, Menlo, monospace; white-space: pre-wrap; margin: 0 }', (doc) => {
      doc.body.textContent = [`Slip shift · ${ops.branchName(shift.branchId)}`, `${dateTime(shift.openedAt)} – ${dateTime(shift.closedAt)}`, '', ...slipRows(slip).map(([label, value]) => `${label.padEnd(16)}${value}`)].join('\n');
    }),
  'printer');
  const close = actionButton('Selesai', 'btn btn-primary');
  close.dataset.close = '';
  openDialog({ title: 'Slip shift', description: `${ops.branchName(shift.branchId)} · ${dateTime(shift.openedAt)} – ${dateTime(shift.closedAt)}`, body: [facts], footer: [print, close] });
}
