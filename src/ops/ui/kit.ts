// Building blocks the business pages share: a page card with actions, tables, badges, money,
// QR codes and file downloads.

import qrcode from 'qrcode-generator';
import { confirmDialog } from '../../dialogs';
import { actionButton, el } from '../../dom';
import type { IconName } from '../../icons';
import { downloadBlob } from '../../render/overlay';
import { formatRupiah } from '../cart';

export { actionButton, el };
export const money = formatRupiah;

export function dateTime(time: number | undefined): string {
  return time ? new Date(time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';
}

export interface PageParts {
  root: HTMLElement;
  actions: HTMLElement;
  body: HTMLElement;
}

/** The page card every business page sits in: title, description, actions, then the content. */
export function page(title: string, description: string): PageParts {
  const root = el('div', 'card page-card ops-page');
  const head = el('header', 'page-head');
  const text = el('div');
  text.append(el('h2', 'card-title', title), el('p', 'card-desc', description));
  const actions = el('div', 'page-actions');
  head.append(text, actions);
  const body = el('div', 'ops-body');
  root.append(head, body);
  return { root, actions, body };
}

export function section(title: string, description = ''): { root: HTMLElement; body: HTMLElement; actions: HTMLElement } {
  const root = el('section', 'ops-section');
  const head = el('div', 'ops-section-head');
  const text = el('div');
  text.append(el('h3', 'ops-section-title', title));
  if (description) text.append(el('p', 'card-desc', description));
  const actions = el('div', 'page-actions');
  head.append(text, actions);
  const body = el('div', 'ops-section-body');
  root.append(head, body);
  return { root, body, actions };
}

export type BadgeKind = 'ok' | 'warn' | 'error' | 'info' | 'muted';

export function badge(text: string, kind: BadgeKind = 'muted'): HTMLElement {
  const span = el('span', 'badge ops-badge', text);
  if (kind !== 'muted') span.dataset.kind = kind;
  return span;
}

export interface Column<T> {
  label: string;
  className?: string;
  cell(row: T): Node | string;
}

/** A data table in a scroll box, with an empty line when there are no rows. */
export function table<T>(columns: Column<T>[], rows: readonly T[], options: { empty?: string; onRow?: (row: T) => void } = {}): HTMLElement {
  const wrap = el('div', 'table-wrap ops-table');
  const tableEl = el('table', 'data-table');
  const head = tableEl.createTHead().insertRow();
  for (const column of columns) {
    const th = el('th', column.className ?? '', column.label);
    th.scope = 'col';
    head.append(th);
  }
  const body = tableEl.createTBody();
  if (rows.length === 0) {
    const cell = body.insertRow().insertCell();
    cell.colSpan = columns.length;
    cell.className = 'cell-empty';
    cell.textContent = options.empty ?? 'Nothing here yet.';
  }
  for (const row of rows) {
    const tr = body.insertRow();
    if (options.onRow) {
      tr.className = 'point-tr';
      tr.addEventListener('click', (event) => {
        if (!(event.target as Element).closest('button, a, input, select')) options.onRow!(row);
      });
    }
    for (const column of columns) {
      const td = tr.insertCell();
      if (column.className) td.className = column.className;
      td.append(column.cell(row));
    }
  }
  wrap.append(tableEl);
  return wrap;
}

/** A row of pill buttons. */
export function pills<T extends string>(options: readonly { value: T; label: string }[], active: T, onPick: (value: T) => void): HTMLElement {
  const group = el('div', 'pill-tabs');
  for (const option of options) {
    const button = el('button', `pill-tab${option.value === active ? ' is-active' : ''}`, option.label);
    button.type = 'button';
    button.addEventListener('click', () => onPick(option.value));
    group.append(button);
  }
  return group;
}

/** A button that runs an action and shows its error in a toast-like line under the page title. */
export function act(label: string, className: string, run: () => unknown | Promise<unknown>, iconName?: IconName): HTMLButtonElement {
  const button = actionButton(label, className, iconName);
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await run();
    } catch (error) {
      notice((error as Error)?.message ?? String(error), 'error');
    } finally {
      button.disabled = false;
    }
  });
  return button;
}

/** Asks before a destructive action, then runs it. */
export function confirmAct(label: string, className: string, question: string, detail: string, run: () => unknown, iconName?: IconName): HTMLButtonElement {
  const button = actionButton(label, className, iconName);
  button.addEventListener('click', () =>
    confirmDialog({ title: question, message: detail, confirmLabel: label, run: async () => void (await run()) }),
  );
  return button;
}

let noticeTimer = 0;

/** A short message at the bottom of the screen: confirmations, errors, alerts. */
export function notice(message: string, kind: 'info' | 'ok' | 'warn' | 'error' = 'info'): void {
  let box = document.querySelector<HTMLElement>('#opsNotice');
  if (!box) {
    box = el('div', 'ops-notice');
    box.id = 'opsNotice';
    box.setAttribute('role', 'status');
    document.body.append(box);
  }
  box.textContent = message;
  box.dataset.kind = kind;
  box.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => (box!.hidden = true), kind === 'error' || kind === 'warn' ? 6000 : 3500);
}

/** A QR code as a crisp canvas. */
export function qrCanvas(text: string, size = 220): HTMLCanvasElement {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const quiet = 4;
  const scale = Math.max(1, Math.floor(size / (count + quiet * 2)));
  const canvas = el('canvas', 'qr');
  canvas.width = canvas.height = (count + quiet * 2) * scale;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000';
  for (let r = 0; r < count; r++) for (let c = 0; c < count; c++) if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'QR code');
  return canvas;
}

export function downloadText(text: string, name: string, type = 'text/csv'): void {
  downloadBlob(new Blob([`﻿${text}`], { type: `${type};charset=utf-8` }), name);
}

export function downloadBytes(bytes: Uint8Array, name: string, type: string): void {
  downloadBlob(new Blob([bytes as BlobPart], { type }), name);
}

export function fileInput(accept: string, onFile: (file: File) => void): HTMLInputElement {
  const input = el('input');
  input.type = 'file';
  input.accept = accept;
  input.hidden = true;
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) onFile(file);
    input.value = '';
  });
  return input;
}

export function statRow(stats: { label: string; value: string; hint?: string }[]): HTMLElement {
  const row = el('div', 'stat-row ops-stats');
  for (const stat of stats) {
    const card = el('div', 'stat');
    const text = el('div', 'stat-text');
    text.append(el('p', 'stat-label', stat.label), el('p', 'stat-value', stat.value));
    if (stat.hint) text.append(el('p', 'stat-hint', stat.hint));
    card.append(text);
    row.append(card);
  }
  return row;
}

/** Reads a whole-rupiah amount typed with or without separators. */
export function parseAmount(text: string): number {
  const digits = String(text).replace(/[^\d-]/g, '');
  return digits ? Number(digits) : 0;
}
