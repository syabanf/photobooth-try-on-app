import { describe, expect, it } from 'vitest';
import type { Ticket } from './model';
import {
  aheadOf,
  callNext,
  checkIn,
  completeTicket,
  issueTicket,
  moveTicket,
  queueFor,
  reRegister,
  recallTicket,
  skipTicket,
  ticketNumber,
} from './queue';

function seed(): Ticket[] {
  let tickets: Ticket[] = [];
  tickets = issueTicket(tickets, { boothIds: ['A', 'B'], checkedIn: true }, 'Q001', 't1', 1);
  tickets = issueTicket(tickets, { boothIds: ['A'], checkedIn: true }, 'Q002', 't2', 2);
  tickets = issueTicket(tickets, { boothIds: ['B'], checkedIn: false }, 'Q003', 't3', 3);
  tickets = issueTicket(tickets, { boothIds: ['B'], checkedIn: true }, 'Q004', 't4', 4);
  return tickets;
}

describe('multi-booth queue', () => {
  it('calls a customer from the first free booth and drops them from every other queue', () => {
    const first = callNext(seed(), 'B', 10);
    expect(first.called?.number).toBe('Q001');
    expect(first.called?.calledBoothId).toBe('B');
    // Booth A must not call Q001 again.
    const second = callNext(first.tickets, 'A', 11);
    expect(second.called?.number).toBe('Q002');
    expect(queueFor(second.tickets, 'A')).toEqual([]);
  });

  it('skips customers who have not checked in yet', () => {
    let tickets = callNext(seed(), 'B', 10).tickets;
    const next = callNext(tickets, 'B', 11);
    expect(next.called?.number).toBe('Q004');
    tickets = checkIn(next.tickets, 't3');
    expect(callNext(tickets, 'B', 12).called?.number).toBe('Q003');
  });

  it('returns nobody when the queue is empty', () => {
    expect(callNext([], 'A', 1).called).toBeNull();
  });

  it('re-calls, completes and skips', () => {
    const { tickets, called } = callNext(seed(), 'A', 10);
    const recalled = recallTicket(tickets, called!.id, 20);
    expect(recalled.find((t) => t.id === called!.id)).toMatchObject({ recalls: 1, calledAt: 20 });
    expect(completeTicket(recalled, called!.id).find((t) => t.id === called!.id)?.status).toBe('done');
    expect(() => recallTicket(seed(), 't2', 1)).toThrow('Only a called ticket');
  });

  it('puts a late customer back at the front or the back', () => {
    const skipped = skipTicket(seed(), 't4');
    const front = reRegister(skipped, 't4', 'front');
    expect(queueFor(front, 'B')[0].number).toBe('Q004');
    const back = reRegister(skipped, 't4', 'back');
    expect(queueFor(back, 'B').at(-1)?.number).toBe('Q004');
  });

  it('reorders by drag', () => {
    const moved = moveTicket(seed(), 't4', 't1');
    expect(queueFor(moved, 'B').map((t) => t.number)).toEqual(['Q004', 'Q001', 'Q003']);
    expect(queueFor(moveTicket(moved, 't4', null), 'B').map((t) => t.number)).toEqual(['Q001', 'Q003', 'Q004']);
  });

  it('counts checked-in customers ahead on shared booths', () => {
    expect(aheadOf(seed(), 't4')).toBe(1);
    expect(aheadOf(seed(), 't2')).toBe(1);
  });

  it('refuses to check in twice or a ticket that is gone', () => {
    expect(() => checkIn(seed(), 'zzz')).toThrow('not in the queue');
    const called = callNext(seed(), 'A', 1).tickets;
    expect(() => checkIn(called, 't1')).toThrow('already called');
  });

  it('numbers tickets and wraps after 999', () => {
    expect(ticketNumber('A', 7)).toBe('A007');
    expect(ticketNumber('A', 1000)).toBe('A001');
  });
});
