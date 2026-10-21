// The application layer: every action the pages take, built from the engines, saved through the
// store, written to the activity log and queued for the cloud.

import type { Account, Sites } from '../account/model';
import { deleteShot } from '../gallery';
import { deleteBlob, putBlob } from './blobs';
import { can, checkPin, findApprover, hashPin, seesBranch, type Permission } from './access';
import { DEFAULT_CAPTURE, DEFAULT_PREVIEW, printImage, SimulatedCloud, SimulatedGateway, type CameraDriver, type CameraState, type PaymentGateway } from './adapters';
import { amountDue, changeFor, lineNet, orderNumber, priceLines, refundMethod } from './cart';
import { sessionsToPurge, targetVersion } from './fleet';
import type {
  BoothProfile,
  BoothSession,
  CameraProfile,
  FaceRecord,
  Channel,
  Order,
  OrderLine,
  OpsState,
  PaperSize,
  Payment,
  PaymentMethod,
  Rupiah,
  SessionMode,
  Shift,
  Staff,
  Ticket,
  Voucher,
} from './model';
import { Outbox } from './outbox';
import { afterPrint, noPrinterReason, pickPrinter } from './printing';
import { callNext, checkIn, completeTicket, issueTicket, moveTicket, reRegister, recallTicket, skipTicket, ticketNumber } from './queue';
import { shiftSlip, type ShiftSlip } from './shift';
import type { OpsStore } from './store';
import { reconcileAlerts, routeAlert, wantedAlerts, type BoothRef } from './telemetry';
import { localTimeZone, zonedTime } from './time';
import { activeEvent, checkVoucher, generateCode, normalizeCode, voucherDiscount } from './vouchers';

export const APP_VERSION = '0.2.0';

export interface CartLine {
  kind: OrderLine['kind'];
  refId: string;
  label: string;
  unitPrice: Rupiah;
  qty: number;
  mode?: SessionMode;
  size?: PaperSize;
}

export interface OpsHooks {
  /** The booth screen popup, for alerts and confirmations. */
  toast(message: string, kind?: 'info' | 'warn' | 'error' | 'ok'): void;
  devicePointId(): string | null;
}

const DAY_MS = 86_400_000;

export class Ops {
  readonly gateway: PaymentGateway;
  readonly cloud: SimulatedCloud;
  readonly outbox: Outbox;
  sites: Sites = { locations: [], points: [] };
  /** The camera driving this device's booth, set by the camera page once it starts. */
  camera: CameraDriver | null = null;
  private actorKey: string;

  constructor(
    readonly store: OpsStore,
    readonly account: Account,
    readonly hooks: OpsHooks,
  ) {
    const key = store.key;
    this.actorKey = `${key}:actor`;
    this.gateway = new SimulatedGateway(
      this.gatewayLabel(),
      () => ({ name: this.state.branding.brandName || account.business, city: this.sites.locations[0]?.city ?? '' }),
      key,
    );
    this.cloud = new SimulatedCloud(`${key}:cloud`);
    this.outbox = new Outbox(localStorage, `${key}:outbox`, (item) => this.cloud.send(item));
    this.gateway.onPaid((reference) => this.qrisPaid(reference));
  }

  get state(): OpsState {
    return this.store.state;
  }

  private gatewayLabel(): string {
    return { midtrans: 'Midtrans', xendit: 'Xendit', doku: 'DOKU' }[this.state.settings.gateway];
  }

  private now(): number {
    return this.store.now();
  }

  /** Writes a change with its activity entry and queues it for the cloud. */
  private commit(kind: string, message: string, change: (draft: OpsState) => void, extra: { amount?: Rupiah; branchId?: string | null; sync?: unknown } = {}): void {
    this.store.update(change, { kind, message, amount: extra.amount, staffId: this.actor()?.id ?? null, branchId: extra.branchId ?? null });
    if (extra.sync !== undefined) {
      this.outbox.enqueue(this.store.id(), kind, extra.sync);
      void this.outbox.flush();
    }
  }

  // ---------- people ----------

  actor(): Staff | null {
    const id = localStorage.getItem(this.actorKey);
    return this.state.staff.find((person) => person.id === id && person.active) ?? this.state.staff.find((person) => person.role === 'owner') ?? null;
  }

  can(permission: Permission): boolean {
    return can(this.actor(), permission);
  }

  require(permission: Permission): void {
    if (!this.can(permission)) throw new Error(`${this.actor()?.name ?? 'This user'} is not allowed to do that.`);
  }

  async switchActor(staffId: string, pin: string): Promise<void> {
    const person = this.state.staff.find((candidate) => candidate.id === staffId && candidate.active);
    if (!person) throw new Error('That person is not on the team.');
    if (person.pinHash && !(await checkPin(person, pin))) throw new Error('Wrong PIN.');
    localStorage.setItem(this.actorKey, person.id);
    this.commit('staff.switch', `${person.name} took over this device.`, () => {});
  }

  async saveStaff(input: Omit<Staff, 'pinHash' | 'pinSalt' | 'id'> & { id?: string }, pin: string): Promise<void> {
    this.require('staff.manage');
    if (!input.name.trim()) throw new Error('Enter a name.');
    const secret = pin ? await hashPin(pin) : null;
    const owners = this.state.staff.filter((person) => person.role === 'owner' && person.active && person.id !== input.id);
    if (owners.length === 0 && (input.role !== 'owner' || !input.active)) throw new Error('The workspace needs an active owner.');
    this.commit('staff.save', `${input.id ? 'Updated' : 'Added'} ${input.name.trim()} (${input.role}).`, (draft) => {
      const existing = draft.staff.find((person) => person.id === input.id);
      const fields = { ...input, name: input.name.trim(), ...(secret ?? {}) };
      if (existing) Object.assign(existing, fields);
      else {
        if ((input.role === 'supervisor' || input.role === 'admin') && !secret) throw new Error('Supervisors and admins need a PIN to approve refunds.');
        draft.staff.push({ pinHash: '', pinSalt: '', ...fields, id: this.store.id() });
      }
    });
  }

  /** Branches the person on this device may see. */
  visibleBranches(): Sites['locations'] {
    return this.sites.locations.filter((location) => seesBranch(this.actor(), location.id));
  }

  visibleBooths(): Sites['points'] {
    const branches = new Set(this.visibleBranches().map((location) => location.id));
    return this.sites.points.filter((point) => branches.has(point.locationId));
  }

  // ---------- booths ----------

  boothName(boothId: string | null): string {
    if (!boothId) return 'Cashier';
    return this.sites.points.find((point) => point.id === boothId)?.name ?? 'Removed booth';
  }

  branchOf(boothId: string | null): string | null {
    return this.sites.points.find((point) => point.id === boothId)?.locationId ?? null;
  }

  branchName(branchId: string | null): string {
    return this.sites.locations.find((location) => location.id === branchId)?.name ?? 'No branch';
  }

  profile(boothId: string): BoothProfile {
    return (
      this.state.booths.find((profile) => profile.pointId === boothId) ?? {
        pointId: boothId,
        categoryId: this.state.categories[0]?.id ?? '',
        timeZone: localTimeZone(),
        modes: ['strip', 'gif', 'video', 'live', 'vintage'],
      }
    );
  }

  saveProfile(profile: BoothProfile): void {
    this.require('settings.manage');
    this.commit('booth.profile', `Updated settings for ${this.boothName(profile.pointId)}.`, (draft) => {
      draft.booths = [...draft.booths.filter((entry) => entry.pointId !== profile.pointId), profile];
    });
  }

  timeZoneOf(boothId: string | null): string {
    return boothId ? this.profile(boothId).timeZone : localTimeZone();
  }

  /** Price of a mode at a booth, from its category. Free while an event voucher runs there. */
  modePrice(boothId: string, mode: SessionMode): { price: Rupiah; event: Voucher | null } {
    const event = activeEvent(this.state.vouchers, { now: this.now(), boothId, timeZone: this.timeZoneOf(boothId) });
    const category = this.state.categories.find((entry) => entry.id === this.profile(boothId).categoryId);
    return { price: event ? 0 : (category?.prices[mode] ?? 0), event };
  }

  /** Booths selling a booth category, for the cashier's session codes and queue tickets. */
  boothsOfCategory(categoryId: string): string[] {
    return this.sites.points.filter((point) => point.active && this.profile(point.id).categoryId === categoryId).map((point) => point.id);
  }

  // ---------- vouchers ----------

  checkVoucher(code: string, boothId: string | null) {
    return checkVoucher(this.state.vouchers, code, { now: this.now(), boothId, timeZone: this.timeZoneOf(boothId) });
  }

  saveVoucher(voucher: Omit<Voucher, 'id' | 'uses' | 'createdAt'> & { id?: string }): void {
    this.require('vouchers.manage');
    const code = normalizeCode(voucher.code);
    if (!code) throw new Error('Enter a code.');
    if (this.state.vouchers.some((other) => other.code === code && other.id !== voucher.id)) throw new Error(`${code} already exists.`);
    if (voucher.kind !== 'free' && voucher.value <= 0) throw new Error('Enter a discount above zero.');
    this.commit('voucher.save', `${voucher.id ? 'Updated' : 'Created'} voucher ${code}.`, (draft) => {
      const existing = draft.vouchers.find((entry) => entry.id === voucher.id);
      if (existing) Object.assign(existing, { ...voucher, code });
      else draft.vouchers.unshift({ ...voucher, code, id: this.store.id(), uses: 0, createdAt: this.now() });
    });
  }

  deleteVoucher(id: string): void {
    this.require('vouchers.manage');
    const voucher = this.state.vouchers.find((entry) => entry.id === id);
    this.commit('voucher.delete', `Deleted voucher ${voucher?.code ?? ''}.`, (draft) => {
      draft.vouchers = draft.vouchers.filter((entry) => entry.id !== id);
    });
  }

  // ---------- shifts ----------

  openShiftFor(branchId: string | null): Shift | null {
    return this.state.shifts.find((shift) => !shift.closedAt && shift.branchId === branchId) ?? null;
  }

  openShift(branchId: string, openingCash: Rupiah): void {
    this.require('shift.run');
    if (this.openShiftFor(branchId)) throw new Error('A shift is already open at this branch.');
    if (openingCash < 0) throw new Error('Opening cash cannot be negative.');
    const shift: Shift = { id: this.store.id(), branchId, staffId: this.actor()?.id ?? null, openedAt: this.now(), openingCash };
    this.commit('shift.open', `Opened a shift at ${this.branchName(branchId)}.`, (draft) => draft.shifts.unshift(shift), { amount: openingCash, branchId, sync: shift });
  }

  closeShift(shiftId: string, countedCash: Rupiah): ShiftSlip {
    this.require('shift.run');
    const shift = this.state.shifts.find((entry) => entry.id === shiftId);
    if (!shift || shift.closedAt) throw new Error('That shift is not open.');
    const closed = { ...shift, closedAt: this.now(), countedCash };
    const slip = shiftSlip(closed, this.state.orders, this.state.refunds);
    this.commit(
      'shift.close',
      `Closed the shift at ${this.branchName(shift.branchId)}. Drawer ${slip.variance === 0 ? 'matches' : slip.variance! < 0 ? 'is short' : 'is over'}.`,
      (draft) => Object.assign(draft.shifts.find((entry) => entry.id === shiftId)!, closed),
      { amount: countedCash, branchId: shift.branchId, sync: closed },
    );
    return slip;
  }

  // ---------- orders ----------

  /** Prices a cart without saving it, for the live total on the till. */
  quote(lines: readonly CartLine[], presetId: string | null, voucherCode: string, boothId: string | null) {
    const orderLines = lines.map((line, index): OrderLine => ({ ...line, id: String(index), discount: 0, refunded: false }));
    const preset = this.state.presets.find((entry) => entry.id === presetId) ?? null;
    const check = voucherCode.trim() ? this.checkVoucher(voucherCode, boothId) : null;
    const voucher = check?.ok ? check.voucher : null;
    return { ...priceLines(orderLines, preset, voucher), voucher, voucherError: check && !check.ok ? check.reason : '' };
  }

  createOrder(input: { lines: CartLine[]; presetId: string | null; voucherCode: string; channel: Channel; branchId: string; boothId: string | null; customerEmail?: string }): Order {
    if (input.lines.length === 0) throw new Error('The cart is empty.');
    if (input.channel === 'cashier') this.require('pos.sell');
    if (input.presetId) this.require('pos.discount');
    const shift = this.openShiftFor(input.branchId);
    if (input.channel === 'cashier' && this.state.settings.shiftsEnabled && !shift) throw new Error('Open a shift before selling.');
    for (const line of input.lines.filter((entry) => entry.kind === 'merch')) {
      const product = this.state.products.find((entry) => entry.id === line.refId);
      const inCart = input.lines.filter((entry) => entry.refId === line.refId).reduce((sum, entry) => sum + entry.qty, 0);
      if (!product || product.stock < inCart) throw new Error(`Only ${product?.stock ?? 0} ${line.label} left in stock.`);
    }
    const quote = this.quote(input.lines, input.presetId, input.voucherCode, input.boothId);
    if (quote.voucherError) throw new Error(quote.voucherError);

    const date = zonedTime(this.now(), this.timeZoneOf(input.boothId)).date;
    const counter = this.state.counters.order + 1;
    const order: Order = {
      id: this.store.id(),
      number: orderNumber(input.channel === 'booth' ? 'BTH' : 'INV', date, counter),
      channel: input.channel,
      branchId: input.branchId,
      boothId: input.boothId,
      staffId: input.channel === 'cashier' ? (this.actor()?.id ?? null) : null,
      shiftId: input.channel === 'cashier' ? (shift?.id ?? null) : null,
      lines: quote.lines.map((line) => ({ ...line, id: this.store.id() })),
      presetId: input.presetId,
      voucherCode: quote.voucher?.code ?? null,
      subtotal: quote.subtotal,
      discount: quote.discount,
      total: quote.total,
      payments: [],
      status: 'open',
      sessionVouchers: [],
      ticketNumbers: [],
      customerEmail: input.customerEmail ?? '',
      createdAt: this.now(),
    };
    this.store.update((draft) => {
      draft.counters.order = counter;
      draft.orders.unshift(order);
    });
    if (order.total === 0) this.finalize(order.id);
    return this.order(order.id);
  }

  order(id: string): Order {
    const order = this.state.orders.find((entry) => entry.id === id);
    if (!order) throw new Error('That order is gone.');
    return order;
  }

  /** Cash, card or e-wallet: paid on the spot. Returns the change for cash. */
  pay(orderId: string, method: Exclude<PaymentMethod, 'qris'>, amount: Rupiah, reference = ''): Rupiah {
    const order = this.order(orderId);
    if (order.status !== 'open') throw new Error(`Order ${order.number} is ${order.status}.`);
    const due = amountDue(order);
    if (method === 'cash' && amount <= 0) throw new Error('Enter the cash received.');
    if (method !== 'cash' && !reference.trim()) throw new Error('Enter the approval or reference number.');
    const applied = method === 'cash' ? Math.min(amount, due) : Math.min(amount || due, due);
    const payment: Payment = { id: this.store.id(), method, amount: applied, status: 'paid', reference: reference.trim(), tendered: method === 'cash' ? amount : undefined, createdAt: this.now(), paidAt: this.now() };
    this.store.update((draft) => draft.orders.find((entry) => entry.id === orderId)!.payments.push(payment));
    if (amountDue(this.order(orderId)) === 0) this.finalize(orderId);
    return method === 'cash' ? changeFor(amount, due) : 0;
  }

  /** Starts a dynamic QRIS charge for what is due. The gateway callback finishes it. */
  async chargeQris(orderId: string): Promise<Payment> {
    const order = this.order(orderId);
    const due = amountDue(order);
    if (due <= 0) throw new Error('Nothing is due.');
    const reference = `${order.number}-${order.payments.length + 1}`;
    const charge = await this.gateway.createQris(due, reference);
    const payment: Payment = { id: this.store.id(), method: 'qris', amount: due, status: 'pending', reference, gateway: this.gateway.label, qrString: charge.qrString, createdAt: this.now() };
    this.store.update((draft) => {
      const target = draft.orders.find((entry) => entry.id === orderId)!;
      // A new QR replaces any earlier one still waiting.
      for (const old of target.payments) if (old.status === 'pending') old.status = 'expired';
      target.payments.push(payment);
    });
    return payment;
  }

  /** The gateway callback: marks the QRIS payment paid and unlocks whatever waited on it. */
  private qrisPaid(reference: string): void {
    const order = this.state.orders.find((entry) => entry.payments.some((payment) => payment.reference === reference && payment.status === 'pending'));
    if (!order) return;
    this.store.update((draft) => {
      const payment = draft.orders.find((entry) => entry.id === order.id)!.payments.find((entry) => entry.reference === reference)!;
      payment.status = 'paid';
      payment.paidAt = this.now();
    });
    if (amountDue(this.order(order.id)) === 0) this.finalize(order.id);
  }

  cancelOrder(orderId: string): void {
    const order = this.order(orderId);
    if (order.status !== 'open') return;
    if (order.payments.some((payment) => payment.status === 'paid')) throw new Error('Part of this order is paid. Refund it instead.');
    this.commit('order.void', `Voided ${order.number}.`, (draft) => {
      const target = draft.orders.find((entry) => entry.id === orderId)!;
      target.status = 'void';
      for (const payment of target.payments) if (payment.status === 'pending') payment.status = 'expired';
    }, { branchId: order.branchId });
  }

  /** Paid in full: stock, vouchers, session codes, queue tickets, log and sync. */
  private finalize(orderId: string): void {
    const order = this.order(orderId);
    if (order.status === 'paid') return;
    const now = this.now();
    const sessionLines = order.lines.filter((line) => line.kind === 'session');
    const codes: Voucher[] = [];
    if (order.channel === 'cashier') {
      const until = zonedTime(now + 30 * DAY_MS, this.timeZoneOf(null)).date;
      for (const line of sessionLines) {
        for (let i = 0; i < line.qty; i++) {
          codes.push({
            id: this.store.id(),
            code: generateCode('S'),
            kind: 'free',
            value: 0,
            scope: 'single',
            boothIds: this.boothsOfCategory(line.refId),
            maxUses: 1,
            uses: 0,
            validFrom: '',
            validTo: until,
            happyHour: null,
            frameIds: [],
            eventMode: false,
            active: true,
            orderId,
            createdAt: now,
          });
        }
      }
    }
    let tickets = this.state.tickets;
    const numbers: string[] = [];
    let ticketCounter = this.state.counters.ticket;
    if (order.channel === 'cashier' && sessionLines.length) {
      const booths = [...new Set(sessionLines.flatMap((line) => this.boothsOfCategory(line.refId)))];
      if (booths.length) {
        ticketCounter += 1;
        const number = ticketNumber(this.state.settings.queuePrefix, ticketCounter);
        tickets = issueTicket(tickets, { boothIds: booths, checkedIn: true, orderId, email: order.customerEmail }, number, this.store.id(), now);
        numbers.push(number);
      }
    }
    const paid = { ...order, status: 'paid' as const, paidAt: now, sessionVouchers: codes.map((code) => code.code), ticketNumbers: numbers };
    this.commit(
      'order.paid',
      `${order.number} paid, ${order.lines.map((line) => `${line.qty}× ${line.label}`).join(', ')}.`,
      (draft) => {
        Object.assign(draft.orders.find((entry) => entry.id === orderId)!, paid);
        for (const line of order.lines.filter((entry) => entry.kind === 'merch')) {
          const product = draft.products.find((entry) => entry.id === line.refId);
          if (product) product.stock = Math.max(0, product.stock - line.qty);
        }
        const used = draft.vouchers.find((voucher) => voucher.code === order.voucherCode);
        if (used) used.uses += 1;
        draft.vouchers.unshift(...codes);
        draft.tickets = tickets;
        draft.counters.ticket = ticketCounter;
      },
      { amount: order.total, branchId: order.branchId, sync: paid },
    );
  }

  /** Refunds one line. A supervisor's PIN approves it, and the reason goes on the audit log. */
  async refund(orderId: string, lineId: string, reason: string, pin: string): Promise<Rupiah> {
    this.require('pos.sell');
    const order = this.order(orderId);
    const line = order.lines.find((entry) => entry.id === lineId);
    if (order.status !== 'paid' || !line) throw new Error('Only paid lines can be refunded.');
    if (line.refunded) throw new Error('That line was refunded already.');
    if (!reason.trim()) throw new Error('Enter a reason.');
    const approver = await findApprover(this.state.staff, pin);
    if (!approver) throw new Error('That PIN does not belong to a supervisor.');
    const amount = lineNet(line);
    const method = refundMethod(order);
    const refund = { id: this.store.id(), orderId, lineId, amount, reason: reason.trim(), staffId: this.actor()?.id ?? null, supervisorId: approver.id, method, at: this.now() };
    this.commit(
      'order.refund',
      `Refunded ${line.label} on ${order.number}: ${reason.trim()}. Approved by ${approver.name}.`,
      (draft) => {
        const target = draft.orders.find((entry) => entry.id === orderId)!;
        target.lines.find((entry) => entry.id === lineId)!.refunded = true;
        draft.refunds.unshift(refund);
        if (line.kind === 'merch') {
          const product = draft.products.find((entry) => entry.id === line.refId);
          if (product) product.stock += line.qty;
        }
        // A refunded session must not be playable with its receipt code.
        if (line.kind === 'session') {
          let left = line.qty;
          for (const voucher of draft.vouchers) {
            if (left > 0 && voucher.orderId === orderId && voucher.uses === 0 && voucher.active) {
              voucher.active = false;
              left -= 1;
            }
          }
        }
      },
      { amount: -amount, branchId: order.branchId, sync: refund },
    );
    return amount;
  }

  // ---------- queue ----------

  private queueChange(kind: string, message: string, change: (tickets: Ticket[]) => Ticket[]): void {
    this.require('queue.run');
    this.commit(kind, message, (draft) => {
      draft.tickets = change(draft.tickets);
    });
  }

  issueTicket(input: { boothIds: string[]; name: string; phone: string; email: string; checkedIn: boolean }): Ticket {
    this.require('queue.run');
    const counter = this.state.counters.ticket + 1;
    const number = ticketNumber(this.state.settings.queuePrefix, counter);
    const id = this.store.id();
    this.commit(`queue.issue`, `Issued ticket ${number}.`, (draft) => {
      draft.tickets = issueTicket(draft.tickets, input, number, id, this.now());
      draft.counters.ticket = counter;
    });
    return this.state.tickets.find((ticket) => ticket.id === id)!;
  }

  callNext(boothId: string): Ticket | null {
    this.require('queue.run');
    const result = callNext(this.state.tickets, boothId, this.now());
    if (!result.called) return null;
    this.commit('queue.call', `${this.boothName(boothId)} called ${result.called.number}.`, (draft) => {
      draft.tickets = callNext(draft.tickets, boothId, this.now()).tickets;
    });
    this.announce(result.called, boothId);
    return result.called;
  }

  recall(ticketId: string): void {
    const ticket = this.state.tickets.find((entry) => entry.id === ticketId)!;
    this.queueChange('queue.recall', `Called ${ticket.number} again.`, (tickets) => recallTicket(tickets, ticketId, this.now()));
    this.announce(ticket, ticket.calledBoothId!);
  }

  completeTicket(ticketId: string): void {
    this.queueChange('queue.done', 'Served a ticket.', (tickets) => completeTicket(tickets, ticketId));
  }

  skipTicket(ticketId: string): void {
    this.queueChange('queue.skip', 'Marked a ticket as a no-show.', (tickets) => skipTicket(tickets, ticketId));
  }

  reRegister(ticketId: string, place: 'front' | 'back'): void {
    this.queueChange('queue.reregister', `Put a late customer back at the ${place}.`, (tickets) => reRegister(tickets, ticketId, place));
  }

  moveTicket(ticketId: string, beforeId: string | null): void {
    this.queueChange('queue.move', 'Reordered the queue.', (tickets) => moveTicket(tickets, ticketId, beforeId));
  }

  checkIn(token: string): Ticket {
    const ticket = this.state.tickets.find((entry) => entry.token === token);
    this.commit('queue.checkin', `${ticket?.number ?? 'A ticket'} checked in.`, (draft) => {
      draft.tickets = checkIn(draft.tickets, token);
    });
    return this.state.tickets.find((entry) => entry.token === token)!;
  }

  /** Tells a called customer by WhatsApp or email when they left a contact. */
  private announce(ticket: Ticket, boothId: string): void {
    const body = `Ticket ${ticket.number}: it's your turn at ${this.boothName(boothId)}.`;
    this.store.update((draft) => {
      if (ticket.phone) draft.notifications.unshift({ id: this.store.id(), channel: 'whatsapp', to: ticket.phone, subject: 'Your turn', body, at: this.now() });
      if (ticket.email) draft.notifications.unshift({ id: this.store.id(), channel: 'email', to: ticket.email, subject: 'Your turn', body, at: this.now() });
    });
  }

  // ---------- booth sessions ----------

  eventAt(boothId: string): string | null {
    const today = zonedTime(this.now(), this.timeZoneOf(boothId)).date;
    return (
      this.state.events.find((event) => (event.boothIds.length === 0 || event.boothIds.includes(boothId)) && (!event.from || event.from <= today) && (!event.to || event.to >= today))?.id ?? null
    );
  }

  /** Redeems a receipt or promo code at a booth, returning the discount it gives on the price. */
  redeemAtBooth(code: string, boothId: string, price: Rupiah): { voucher: Voucher; discount: Rupiah } {
    const check = this.checkVoucher(code, boothId);
    if (!check.ok) throw new Error(check.reason);
    return { voucher: check.voucher, discount: voucherDiscount(check.voucher, price) };
  }

  startSession(input: { boothId: string; mode: SessionMode; price: Rupiah; orderId: string | null; voucherCode: string | null; frameId: string | null }): BoothSession {
    const session: BoothSession = {
      id: this.store.id(),
      boothId: input.boothId,
      branchId: this.branchOf(input.boothId) ?? '',
      mode: input.mode,
      orderId: input.orderId,
      voucherCode: input.voucherCode,
      frameId: input.frameId,
      eventId: this.eventAt(input.boothId),
      price: input.price,
      startedAt: this.now(),
      shotIds: [],
      prints: 0,
      token: crypto.randomUUID().replaceAll('-', '').slice(0, 16),
      consent: false,
      email: '',
    };
    this.commit('session.start', `${this.boothName(input.boothId)} started a ${input.mode} session.`, (draft) => {
      draft.sessions.unshift(session);
      if (input.voucherCode) {
        const voucher = draft.vouchers.find((entry) => entry.code === input.voucherCode);
        if (voucher) voucher.uses += 1;
      }
    }, { branchId: session.branchId });
    return session;
  }

  attachShot(sessionId: string, shotId: string): void {
    this.store.update((draft) => draft.sessions.find((entry) => entry.id === sessionId)?.shotIds.push(shotId));
  }

  /** Closes a session with the customer's sharing choice, and emails the link when asked. */
  endSession(sessionId: string, consent: boolean, email: string): BoothSession {
    const session = this.state.sessions.find((entry) => entry.id === sessionId)!;
    const ended = { ...session, consent, email: email.trim(), endedAt: this.now() };
    this.commit('session.end', `${this.boothName(session.boothId)} finished a session${consent ? ', sharing allowed' : ''}.`, (draft) => {
      Object.assign(draft.sessions.find((entry) => entry.id === sessionId)!, ended);
      if (ended.email) {
        draft.notifications.unshift({
          id: this.store.id(),
          channel: 'email',
          to: ended.email,
          subject: `Your photos from ${this.state.branding.brandName || this.account.business}`,
          body: `Download your photos: ${this.galleryLink(ended)}`,
          at: this.now(),
        });
      }
    }, { branchId: session.branchId, sync: ended });
    return ended;
  }

  private customDomain(): string {
    return this.state.branding.customDomain.trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
  }

  /** The customer's soft-file page, on the client's own domain when one is set. */
  galleryLink(session: Pick<BoothSession, 'token'>): string {
    const domain = this.customDomain();
    return domain ? `https://${domain}/g/${session.token}` : `${location.origin}${location.pathname}#g=${session.token}`;
  }

  eventLink(eventId: string): string {
    const domain = this.customDomain();
    return domain ? `https://${domain}/e/${eventId}` : `${location.origin}${location.pathname}#event=${eventId}`;
  }

  // ---------- printing ----------

  /** The first priced size a printer at the booth takes, so a print never goes to a size it lacks. */
  printSizeFor(boothId: string | null): PaperSize {
    const takes = new Set(this.state.printers.filter((printer) => boothId && printer.boothIds.includes(boothId)).flatMap((printer) => printer.sizes));
    const { printPrices } = this.state;
    return (printPrices.find((entry) => takes.has(entry.size)) ?? printPrices.find((entry) => entry.size === '4R') ?? printPrices[0])?.size ?? '4R';
  }

  /** Sends a picture to the booth's printer and counts the paper down. */
  async print(boothId: string, image: Blob, size: PaperSize, copies: number, sessionId: string | null = null): Promise<string> {
    const printer = pickPrinter(this.state.printers, boothId, size);
    if (!printer) throw new Error(noPrinterReason(this.state.printers, boothId, size));
    await printImage(image, { size, copies });
    this.commit('print', `${printer.name} printed ${copies}× ${size} for ${this.boothName(boothId)}.`, (draft) => {
      const target = draft.printers.find((entry) => entry.id === printer.id)!;
      Object.assign(target, afterPrint(target, copies));
      const session = draft.sessions.find((entry) => entry.id === sessionId);
      if (session) session.prints += copies;
    }, { branchId: this.branchOf(boothId) });
    this.checkAlerts();
    return printer.name;
  }

  // ---------- cameras ----------

  cameraProfile(boothId: string): CameraProfile {
    return this.state.cameras.find((entry) => entry.boothId === boothId) ?? { boothId, driver: 'webcam', preview: { ...DEFAULT_PREVIEW }, capture: { ...DEFAULT_CAPTURE }, secondaryDeviceId: '' };
  }

  /** Saves a booth's camera profiles; this device's camera takes the preview profile at once. */
  saveCameraProfile(profile: CameraProfile): void {
    this.require('devices.manage');
    this.commit('camera.profile', `Saved camera settings for ${this.boothName(profile.boothId)}.`, (draft) => {
      draft.cameras = [...draft.cameras.filter((entry) => entry.boothId !== profile.boothId), profile];
    });
    if (profile.boothId === this.hooks.devicePointId()) void this.camera?.apply('preview', profile.preview).catch(() => {});
  }

  // ---------- telemetry ----------

  heartbeat(boothId: string, camera: CameraState): void {
    const version = this.state.health.find((entry) => entry.boothId === boothId)?.version ?? APP_VERSION;
    this.store.update((draft) => {
      draft.health = [
        ...draft.health.filter((entry) => entry.boothId !== boothId),
        { boothId, lastHeartbeat: this.now(), version, cameraConnected: camera.connected, cameraBattery: camera.battery, online: true },
      ];
    });
    this.checkAlerts();
  }

  boothRefs(): BoothRef[] {
    return this.sites.points.map((point) => ({ id: point.id, name: point.name, branchId: point.locationId }));
  }

  /** Opens and resolves alerts, and notifies the people each new one is routed to. */
  checkAlerts(): void {
    const wanted = wantedAlerts(this.state.printers, this.state.health, this.boothRefs(), this.now());
    const result = reconcileAlerts(this.state.alerts, wanted, this.now(), () => this.store.id());
    const reworded = result.alerts.some((alert, index) => this.state.alerts[index] && alert.message !== this.state.alerts[index].message);
    if (result.opened.length === 0 && result.resolved.length === 0 && !reworded) return;
    const device = this.hooks.devicePointId();
    this.store.update((draft) => {
      draft.alerts = result.alerts.slice(-500);
      for (const alert of result.opened) {
        for (const delivery of routeAlert(alert, draft.rules, draft.staff)) {
          if (delivery.channel === 'popup') continue;
          draft.notifications.unshift({ id: this.store.id(), channel: delivery.channel, to: delivery.to, subject: alert.message, body: `${alert.message} (${this.branchName(alert.branchId)})`, at: this.now() });
        }
        draft.activity.unshift({ id: this.store.id(), at: this.now(), staffId: null, branchId: alert.branchId, kind: `alert.${alert.kind}`, message: alert.message });
      }
      draft.notifications.length = Math.min(draft.notifications.length, 500);
    });
    for (const alert of result.opened) {
      // The popup shows on the booth the alert is about, or on every device for branch-wide ones.
      const popup = routeAlert(alert, this.state.rules, this.state.staff).some((delivery) => delivery.channel === 'popup');
      if (popup && (!alert.boothId || alert.boothId === device || !device)) this.hooks.toast(alert.message, 'warn');
    }
  }

  // ---------- fleet ----------

  installedVersion(boothId: string): string {
    return this.state.health.find((entry) => entry.boothId === boothId)?.version ?? APP_VERSION;
  }

  targetFor(boothId: string): string {
    return targetVersion(this.state.releases, boothId, APP_VERSION);
  }

  /** The update agent on this device: installs the version the rollout gives it. */
  applyUpdate(boothId: string): string {
    const target = this.targetFor(boothId);
    this.commit('fleet.update', `${this.boothName(boothId)} moved to ${target}.`, (draft) => {
      const health = draft.health.find((entry) => entry.boothId === boothId);
      if (health) health.version = target;
      else draft.health.push({ boothId, lastHeartbeat: this.now(), version: target, cameraConnected: true, cameraBattery: null, online: true });
    });
    return target;
  }

  // ---------- faces ----------

  /** Keeps a face crop for AI presets. It follows the photo retention window like every capture. */
  async addFace(image: Blob, boothId: string | null): Promise<FaceRecord> {
    const face: FaceRecord = { id: this.store.id(), image: await putBlob(image), boothId, createdAt: this.now() };
    this.commit('face.capture', `${this.boothName(boothId)} captured a face for AI presets.`, (draft) => draft.faces.unshift(face), { branchId: this.branchOf(boothId) });
    return face;
  }

  async deleteFace(id: string): Promise<void> {
    const face = this.state.faces.find((entry) => entry.id === id);
    if (!face) return;
    await deleteBlob(face.image);
    this.commit('face.delete', 'Deleted a captured face.', (draft) => {
      draft.faces = draft.faces.filter((entry) => entry.id !== id);
    });
  }

  // ---------- retention ----------

  /** Deletes the files of sessions past the retention window, keeping the sales record. */
  async purgeExpired(): Promise<number> {
    await this.purgeFaces();
    const expired = sessionsToPurge(this.state.sessions, this.state.settings.retentionDays, this.now());
    if (expired.length === 0) return 0;
    for (const session of expired) for (const shotId of session.shotIds) await deleteShot(shotId);
    const ids = new Set(expired.map((session) => session.id));
    this.commit('retention.purge', `Deleted the photos of ${expired.length} sessions older than ${this.state.settings.retentionDays} days.`, (draft) => {
      for (const session of draft.sessions) {
        if (ids.has(session.id)) {
          session.purgedAt = this.now();
          session.shotIds = [];
        }
      }
    });
    return expired.length;
  }

  /** Faces are personal data too: they go when the photos would. */
  private async purgeFaces(): Promise<void> {
    const days = this.state.settings.retentionDays;
    if (days <= 0) return;
    const cutoff = this.now() - days * DAY_MS;
    const old = this.state.faces.filter((face) => face.createdAt < cutoff);
    if (old.length === 0) return;
    for (const face of old) await deleteBlob(face.image);
    const ids = new Set(old.map((face) => face.id));
    this.commit('retention.faces', `Deleted ${old.length} captured faces older than ${days} days.`, (draft) => {
      draft.faces = draft.faces.filter((face) => !ids.has(face.id));
    });
  }

  // ---------- generic edits ----------

  /** Small configuration edits (catalogue, printers, frames, ads …) behind one permission check. */
  edit(permission: Permission, kind: string, message: string, change: (draft: OpsState) => void): void {
    this.require(permission);
    this.commit(kind, message, change);
  }
}
