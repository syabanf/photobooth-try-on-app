// Device telemetry: which alerts should be open given the printers and booth heartbeats, and who
// hears about each one.

import type { Alert, AlertKind, BoothHealth, NotifyChannel, Printer, RoutingRule, Staff } from './model';
import { paperState } from './printing';

/** A booth that has not sent a heartbeat for this long counts as offline. */
export const OFFLINE_AFTER_MS = 2 * 60_000;
const LOW_BATTERY = 20;

export interface BoothRef {
  id: string;
  name: string;
  branchId: string;
}

export type WantedAlert = Pick<Alert, 'kind' | 'subject' | 'branchId' | 'boothId' | 'message'>;

export const isOnline = (health: BoothHealth | undefined, now: number) => !!health && now - health.lastHeartbeat < OFFLINE_AFTER_MS;

export function wantedAlerts(printers: readonly Printer[], health: readonly BoothHealth[], booths: readonly BoothRef[], now: number): WantedAlert[] {
  const wanted: WantedAlert[] = [];
  const boothOf = new Map(booths.map((booth) => [booth.id, booth]));

  for (const printer of printers) {
    const booth = boothOf.get(printer.boothIds[0]);
    const where = { branchId: booth?.branchId ?? null, boothId: booth?.id ?? null };
    const state = paperState(printer);
    if (state !== 'ok') {
      wanted.push({
        kind: 'low-paper',
        subject: `paper:${printer.id}`,
        ...where,
        message: state === 'empty' ? `${printer.name} is out of paper.` : `${printer.name} has ${printer.paperLeft} sheets left.`,
      });
    }
    if (printer.status === 'error') {
      wanted.push({ kind: 'printer-error', subject: `printer:${printer.id}`, ...where, message: `${printer.name}: ${printer.error || 'error'}.` });
    }
  }

  for (const booth of booths) {
    const state = health.find((entry) => entry.boothId === booth.id);
    // A booth that never reported is unconfigured, not offline.
    if (!state) continue;
    const where = { branchId: booth.branchId, boothId: booth.id };
    if (!isOnline(state, now)) {
      wanted.push({ kind: 'booth-offline', subject: `offline:${booth.id}`, ...where, message: `${booth.name} stopped reporting.` });
      continue;
    }
    if (!state.cameraConnected) {
      wanted.push({ kind: 'camera-disconnected', subject: `camera:${booth.id}`, ...where, message: `${booth.name}: the camera is disconnected.` });
    } else if (state.cameraBattery !== null && state.cameraBattery <= LOW_BATTERY) {
      wanted.push({ kind: 'camera-battery', subject: `battery:${booth.id}`, ...where, message: `${booth.name}: camera battery at ${state.cameraBattery}%.` });
    }
  }
  return wanted;
}

export interface Reconciled {
  alerts: Alert[];
  opened: Alert[];
  resolved: Alert[];
}

/** Opens alerts that are new, resolves the ones whose cause went away, and leaves the rest. */
export function reconcileAlerts(existing: readonly Alert[], wanted: readonly WantedAlert[], now: number, newId: () => string): Reconciled {
  const open = existing.filter((alert) => !alert.resolvedAt);
  const wantedSubjects = new Set(wanted.map((alert) => alert.subject));
  const openSubjects = new Set(open.map((alert) => alert.subject));

  const resolved = open.filter((alert) => !wantedSubjects.has(alert.subject)).map((alert) => ({ ...alert, resolvedAt: now }));
  const opened = wanted.filter((alert) => !openSubjects.has(alert.subject)).map((alert) => ({ ...alert, id: newId(), openedAt: now }));
  const resolvedIds = new Map(resolved.map((alert) => [alert.id, alert]));
  // An open alert keeps its id and time but shows the latest reading, such as the sheets left.
  const latest = new Map(wanted.map((alert) => [alert.subject, alert.message]));
  const refresh = (alert: Alert) => (!alert.resolvedAt && latest.has(alert.subject) ? { ...alert, message: latest.get(alert.subject)! } : alert);
  return {
    alerts: [...existing.map((alert) => resolvedIds.get(alert.id) ?? refresh(alert)), ...opened],
    opened,
    resolved,
  };
}

export interface Delivery {
  channel: NotifyChannel;
  /** Email address or phone number; empty for the booth popup. */
  to: string;
  name: string;
}

/** With no rule for the branch, every alert pops up on the booth and goes to the owner and on-duty staff. */
const DEFAULT_RULE: Omit<RoutingRule, 'id'> = {
  branchId: null,
  kinds: ['low-paper', 'printer-error', 'camera-disconnected', 'camera-battery', 'booth-offline'],
  channels: ['popup', 'email', 'whatsapp'],
  recipients: ['owner', 'on-duty'],
};

export function routeAlert(alert: Pick<Alert, 'kind' | 'branchId'>, rules: readonly RoutingRule[], staff: readonly Staff[]): Delivery[] {
  const branchRules = rules.filter((rule) => rule.branchId === alert.branchId && rule.kinds.includes(alert.kind));
  const globalRules = rules.filter((rule) => rule.branchId === null && rule.kinds.includes(alert.kind));
  // The most specific rules win: branch rules, then workspace rules, then the default.
  const chosen = branchRules.length ? branchRules : globalRules.length ? globalRules : [DEFAULT_RULE];

  const inBranch = (person: Staff) => person.branchIds.length === 0 || (alert.branchId !== null && person.branchIds.includes(alert.branchId));
  const deliveries = new Map<string, Delivery>();
  for (const rule of chosen) {
    const people = staff.filter(
      (person) =>
        person.active &&
        inBranch(person) &&
        rule.recipients.some((recipient) => recipient === person.id || (recipient === 'owner' && person.role === 'owner') || (recipient === 'on-duty' && person.onDuty)),
    );
    for (const channel of rule.channels) {
      if (channel === 'popup') {
        deliveries.set('popup', { channel, to: '', name: 'Booth screen' });
        continue;
      }
      for (const person of people) {
        const to = channel === 'email' ? person.email : person.phone;
        if (to) deliveries.set(`${channel}:${to}`, { channel, to, name: person.name });
      }
    }
  }
  return [...deliveries.values()];
}

export const ALERT_KINDS: AlertKind[] = DEFAULT_RULE.kinds;
