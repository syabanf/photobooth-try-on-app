// The entrance. A scanner or the keyboard names a ticket, and the camera on this device (a CCTV
// over an IP link, or a webcam) photographs everyone standing in front of it. Their faces follow
// the ticket to the booth, where the party picks who goes into the picture. A ticket that checks
// in from a phone while this screen is open is photographed the same way.

import { canvasToBlob } from '../../render/overlay';
import { blobUrl } from '../blobs';
import type { FaceRecord, Ticket } from '../model';
import type { Ops } from '../ops';
import { arrivals } from '../queue';
import { nameButton, tagFaceDialog } from './face-tag';
import { act, badge, count, el, notice } from './kit';

export interface GateHooks {
  /** One 4:5 headshot per face in view; throws when nobody is there. */
  captureFaces(): Promise<HTMLCanvasElement[]>;
  flash(): void;
}

interface Arrival {
  ticket: Ticket;
  faces: FaceRecord[];
  error: string;
}

export function mountGatePanel(ops: Ops, hooks: GateHooks) {
  const panel = document.querySelector<HTMLElement>('#gatePanel')!;
  let visible = false;
  let last: Arrival | null = null;
  /** Tickets being photographed right now, so a scan and its own check-in never shoot twice. */
  const pending = new Set<string>();
  let known = ops.state.tickets;

  // ---------- the scanner ----------
  const form = el('form', 'field-row');
  const input = el('input', 'input');
  input.placeholder = 'Ticket number or QR';
  input.autocomplete = 'off';
  input.setAttribute('aria-label', 'Ticket number or QR');
  const submit = el('button', 'btn btn-primary', 'Check in');
  submit.type = 'submit';
  form.append(input, submit);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const code = input.value;
    input.value = '';
    input.focus();
    try {
      scan(code);
    } catch (error) {
      notice((error as Error).message, 'error');
    }
  });
  const scanner = card('Gate', 'Scan the ticket QR or type its number. The camera photographs everyone standing here, and their faces wait at the booth.', null, form);
  const arrivalsCard = el('div');

  function card(title: string, description: string, aside: Node | null, ...content: Node[]): HTMLElement {
    const section = el('section', 'card');
    const head = el('header', 'card-head');
    const text = el('div');
    text.append(el('h2', 'card-title', title), el('p', 'card-desc', description));
    head.append(text, ...(aside ? [aside] : []));
    const body = el('div', 'card-body');
    body.append(...content);
    section.append(head, body);
    return section;
  }

  function scan(code: string): void {
    const ticket = ops.findTicket(code);
    // Its own check-in must not shoot a second time through the subscription below.
    pending.add(ticket.id);
    ops.arrive(code);
    void photograph(ticket);
  }

  async function photograph(ticket: Ticket): Promise<void> {
    pending.add(ticket.id);
    last = { ticket, faces: [], error: '' };
    draw();
    try {
      hooks.flash();
      const crops = await hooks.captureFaces();
      const faces: FaceRecord[] = [];
      for (const crop of crops) faces.push(await ops.addFace(await canvasToBlob(crop, 'image/jpeg', 0.92), ops.hooks.devicePointId(), ticket.id));
      last = { ticket, faces, error: '' };
    } catch (error) {
      last = { ticket, faces: [], error: (error as Error).message };
    } finally {
      pending.delete(ticket.id);
      draw();
    }
  }

  // ---------- who arrived ----------
  function arrivalCard(arrival: Arrival): HTMLElement {
    // The scan checked the ticket in after the arrival was noted; show it as it is now.
    const ticket = ops.state.tickets.find((entry) => entry.id === arrival.ticket.id) ?? arrival.ticket;
    const status = ticket.status === 'called' ? badge(`Called to ${ops.boothName(ticket.calledBoothId)}`, 'info') : badge(ticket.checkedIn ? 'Checked in' : ticket.status, ticket.checkedIn ? 'ok' : 'warn');
    const body: Node[] = [];
    if (pending.has(ticket.id)) body.push(el('p', 'card-desc', 'Photographing…'));
    else if (arrival.error) body.push(el('p', 'callout', arrival.error));
    else {
      // Names and deletions from the tag panel show at once.
      const faces = ops.facesForTicket(ticket.id).filter((face) => arrival.faces.some((taken) => taken.id === face.id));
      const grid = el('div', 'face-grid');
      for (const face of faces) {
        const tile = el('button', 'face-tile');
        tile.type = 'button';
        const img = el('img');
        img.alt = face.name || 'Captured face';
        void blobUrl(face.image).then((url) => (img.src = url));
        tile.append(img);
        tile.addEventListener('click', () => tagFaceDialog(ops, face));
        const cell = el('div', 'face-cell');
        cell.append(tile, nameButton(ops, face));
        grid.append(cell);
      }
      body.push(el('p', 'card-desc', `${count(faces.length, 'face')} saved for ${ticket.number}. Tap a face to name who it is.`), grid);
    }
    const again = act('Take again', 'btn btn-outline btn-sm', () => photograph(ticket), 'camera');
    again.disabled = pending.has(ticket.id);
    return card(ticket.number, [ticket.name, ticket.boothIds.map((id) => ops.boothName(id)).join(' / ')].filter(Boolean).join(' · '), status, ...body, again);
  }

  function recentCard(): HTMLElement {
    const counts = new Map<string, number>();
    for (const face of ops.state.faces) if (face.ticketId) counts.set(face.ticketId, (counts.get(face.ticketId) ?? 0) + 1);
    const recent = ops.state.tickets.filter((ticket) => counts.has(ticket.id) && ticket.id !== last?.ticket.id).sort((a, b) => b.createdAt - a.createdAt).slice(0, 8);
    const rows: HTMLElement[] = recent.map((ticket) => {
      const row = el('button', 'cart-line gate-row');
      row.type = 'button';
      row.append(el('span', 'queue-number', ticket.number), el('span', 'rank-meta', ticket.name || ops.boothName(ticket.boothIds[0])), badge(count(counts.get(ticket.id)!, 'face'), ticket.status === 'done' ? 'muted' : 'ok'));
      row.addEventListener('click', () => void photograph(ticket));
      return row;
    });
    if (rows.length === 0) rows.push(el('p', 'card-desc', last ? 'No other party has been photographed yet.' : 'Nobody has been photographed yet.'));
    return card('Photographed today', 'Tap a ticket to photograph the party again.', null, ...rows);
  }

  function draw(): void {
    if (!visible) return;
    arrivalsCard.replaceChildren(...(last ? [arrivalCard(last)] : []), recentCard());
  }

  ops.store.subscribe((state) => {
    const arrived = arrivals(known, state.tickets);
    known = state.tickets;
    if (!visible) return;
    for (const ticket of arrived) if (!pending.has(ticket.id)) void photograph(ticket);
    draw();
  });

  // A USB scanner types wherever the cursor is, so keystrokes on this screen go to the scan box.
  document.addEventListener('keydown', (event) => {
    if (!visible || event.ctrlKey || event.metaKey || event.altKey) return;
    const active = document.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || document.querySelector('.dialog-root')) return;
    input.focus();
  });

  panel.append(scanner, arrivalsCard);

  return {
    show(): void {
      visible = true;
      known = ops.state.tickets;
      draw();
      // After the menu sheet closes, focus goes back to where it was; the scan box takes it then.
      setTimeout(() => input.focus(), 50);
    },
    hide(): void {
      visible = false;
    },
  };
}
