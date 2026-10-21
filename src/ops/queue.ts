// The multi-booth queue. A customer can hold a place for several booths at once; the first booth
// to free up calls them, and a called ticket leaves every other queue, so nobody is called twice.
// Every function returns a new list and leaves its input alone.

import type { Ticket } from './model';

export interface NewTicket {
  boothIds: string[];
  name?: string;
  phone?: string;
  email?: string;
  orderId?: string | null;
  /** Tickets from the cashier are on site already; booked ones check in by scanning their QR. */
  checkedIn: boolean;
}

const waiting = (tickets: readonly Ticket[]) => tickets.filter((ticket) => ticket.status === 'waiting');

function lastPosition(tickets: readonly Ticket[]): number {
  return Math.max(0, ...waiting(tickets).map((ticket) => ticket.position));
}

export function issueTicket(
  tickets: readonly Ticket[],
  input: NewTicket,
  number: string,
  token: string,
  now: number,
): Ticket[] {
  if (input.boothIds.length === 0) throw new Error('Pick at least one booth.');
  const ticket: Ticket = {
    id: token,
    number,
    token,
    boothIds: [...input.boothIds],
    status: 'waiting',
    position: lastPosition(tickets) + 1,
    checkedIn: input.checkedIn,
    calledBoothId: null,
    recalls: 0,
    name: input.name ?? '',
    phone: input.phone ?? '',
    email: input.email ?? '',
    orderId: input.orderId ?? null,
    createdAt: now,
  };
  return [...tickets, ticket];
}

/** "A007": the prefix, then a running number that wraps after 999. */
export function ticketNumber(prefix: string, counter: number): string {
  return `${prefix}${String(((counter - 1) % 999) + 1).padStart(3, '0')}`;
}

/** Tickets waiting for a booth, in the order they will be called. */
export function queueFor(tickets: readonly Ticket[], boothId: string): Ticket[] {
  return waiting(tickets)
    .filter((ticket) => ticket.boothIds.includes(boothId))
    .sort((a, b) => a.position - b.position);
}

export interface CallResult {
  tickets: Ticket[];
  called: Ticket | null;
}

/** The free booth calls the first checked-in customer waiting for it. */
export function callNext(tickets: readonly Ticket[], boothId: string, now: number): CallResult {
  const next = queueFor(tickets, boothId).find((ticket) => ticket.checkedIn);
  if (!next) return { tickets: [...tickets], called: null };
  const called: Ticket = { ...next, status: 'called', calledBoothId: boothId, calledAt: now };
  return { tickets: tickets.map((ticket) => (ticket.id === next.id ? called : ticket)), called };
}

function update(tickets: readonly Ticket[], id: string, change: (ticket: Ticket) => Ticket): Ticket[] {
  if (!tickets.some((ticket) => ticket.id === id)) throw new Error('That ticket is gone.');
  return tickets.map((ticket) => (ticket.id === id ? change(ticket) : ticket));
}

export const completeTicket = (tickets: readonly Ticket[], id: string) =>
  update(tickets, id, (ticket) => ({ ...ticket, status: 'done' }));

/** A no-show: out of the queue until they re-register. */
export const skipTicket = (tickets: readonly Ticket[], id: string) =>
  update(tickets, id, (ticket) => ({ ...ticket, status: 'skipped', calledBoothId: null }));

/** Calls the same customer again, for the TV display and the notification. */
export const recallTicket = (tickets: readonly Ticket[], id: string, now: number) =>
  update(tickets, id, (ticket) => {
    if (ticket.status !== 'called') throw new Error('Only a called ticket can be called again.');
    return { ...ticket, recalls: ticket.recalls + 1, calledAt: now };
  });

/** A late or skipped customer comes back, to the front or the back as the operator decides. */
export function reRegister(tickets: readonly Ticket[], id: string, place: 'front' | 'back'): Ticket[] {
  const positions = waiting(tickets).map((ticket) => ticket.position);
  const position = place === 'front' ? Math.min(1, ...positions) - 1 : Math.max(0, ...positions) + 1;
  return update(tickets, id, (ticket) => ({ ...ticket, status: 'waiting', calledBoothId: null, checkedIn: true, position }));
}

/** Drag reorder: moves a waiting ticket in front of another, or to the end when `beforeId` is null. */
export function moveTicket(tickets: readonly Ticket[], id: string, beforeId: string | null): Ticket[] {
  const order = waiting(tickets).sort((a, b) => a.position - b.position).map((ticket) => ticket.id).filter((other) => other !== id);
  if (!waiting(tickets).some((ticket) => ticket.id === id)) throw new Error('Only waiting tickets can move.');
  const at = beforeId === null ? order.length : order.indexOf(beforeId);
  order.splice(at < 0 ? order.length : at, 0, id);
  const rank = new Map(order.map((ticketId, index) => [ticketId, index + 1]));
  return tickets.map((ticket) => (rank.has(ticket.id) ? { ...ticket, position: rank.get(ticket.id)! } : ticket));
}

export function checkIn(tickets: readonly Ticket[], token: string): Ticket[] {
  const ticket = tickets.find((candidate) => candidate.token === token);
  if (!ticket) throw new Error('This ticket is not in the queue.');
  if (ticket.status !== 'waiting') throw new Error(`Ticket ${ticket.number} is already ${ticket.status}.`);
  return update(tickets, ticket.id, (current) => ({ ...current, checkedIn: true }));
}

/** How many checked-in customers are ahead for the booths a ticket waits for. */
export function aheadOf(tickets: readonly Ticket[], id: string): number {
  const ticket = tickets.find((candidate) => candidate.id === id);
  if (!ticket || ticket.status !== 'waiting') return 0;
  return waiting(tickets).filter(
    (other) => other.position < ticket.position && other.checkedIn && other.boothIds.some((booth) => ticket.boothIds.includes(booth)),
  ).length;
}
