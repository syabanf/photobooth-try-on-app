// Screens that open on their own, from a hash in the URL, with no camera and no menu:
//   #display=customer  the customer-facing screen beside the till (live cart, QRIS, queue number)
//   #display=queue     the TV in the waiting area
//   #display=kiosk     the self-service AI preset kiosk (&booth=<id> names its booth)
//   #g=<token>         a customer's soft-file page, from the QR at the end of a session
//   #event=<id>        every shared session of an event
//   #checkin=<token>   self check-in from a queue ticket QR

import { getShots, isMotion, type Shot } from '../../gallery';
import { extensionOf } from '../../gallery-view';
import { downloadBlob } from '../../render/overlay';
import { blobUrl } from '../blobs';
import { zip } from '../encoders';
import type { BoothSession } from '../model';
import type { Ops } from '../ops';
import { aheadOf, queueFor } from '../queue';
import { mountLockControl } from './display-lock';
import { renderKiosk } from './kiosk';
import { el, money, qrCanvas } from './kit';

export function displayChannel(ops: Ops): BroadcastChannel | null {
  try {
    return new BroadcastChannel(`${ops.store.key}:display`);
  } catch {
    return null;
  }
}

export type DisplayRoute = { kind: 'customer' | 'queue' } | { kind: 'kiosk'; boothId: string | null } | { kind: 'gallery' | 'event' | 'checkin'; id: string };

export function displayRoute(hash: string): DisplayRoute | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const display = params.get('display');
  if (display === 'customer' || display === 'queue') return { kind: display };
  if (display === 'kiosk') return { kind: 'kiosk', boothId: params.get('booth') };
  for (const [key, kind] of [['g', 'gallery'], ['event', 'event'], ['checkin', 'checkin']] as const) {
    const id = params.get(key);
    if (id) return { kind, id };
  }
  return null;
}

/** Applies the workspace's brand colours to a standalone screen. */
async function brand(ops: Ops, root: HTMLElement): Promise<HTMLElement> {
  const { branding } = ops.state;
  root.style.setProperty('--brand-accent', branding.accent);
  root.style.setProperty('--brand-ink', branding.ink);
  root.style.setProperty('--brand-bg', branding.background);
  const head = el('header', 'display-head');
  const logo = await blobUrl(branding.logo);
  if (logo) {
    const img = el('img', 'display-logo');
    img.src = logo;
    img.alt = branding.brandName;
    head.append(img);
  } else {
    const name = el('span', 'display-brand', branding.brandName || ops.account.business);
    name.append(el('span', 'display-period', '.'));
    head.append(name);
  }
  return head;
}

export async function renderDisplay(ops: Ops, route: DisplayRoute): Promise<void> {
  document.body.classList.add('display-mode');
  const root = el('main', `display display--${route.kind}`);
  document.body.replaceChildren(root);
  const head = await brand(ops, root);
  const content = el('section', 'display-content');
  root.append(head, content);

  if (route.kind === 'customer') customerScreen(ops, content);
  else if (route.kind === 'queue') queueScreen(ops, content, head);
  else if (route.kind === 'kiosk') renderKiosk(ops, content, head);
  else if (route.kind === 'checkin') checkInScreen(ops, content, route.id);
  else if (route.kind === 'gallery') {
    const token = route.id;
    const session = ops.state.sessions.find((entry) => entry.token === token);
    await galleryScreen(ops, content, session ? [session] : [], session ? null : 'This link has no photos on this device.');
  } else if (route.kind === 'event') {
    const eventId = route.id;
    const event = ops.state.events.find((entry) => entry.id === eventId);
    const sessions = ops.state.sessions.filter((session) => session.eventId === eventId && session.consent && !session.purgedAt);
    content.append(el('h1', 'display-title', event?.name ?? 'Event gallery'));
    await galleryScreen(ops, content, sessions, event ? null : 'This event is not on this device.');
  }
  // The lock sits at the end of the top bar, after the clock or the step pills.
  if (route.kind === 'customer' || route.kind === 'queue' || route.kind === 'kiosk') mountLockControl(ops, head);
}

function customerScreen(ops: Ops, content: HTMLElement): void {
  const show = (message: { type: string; [key: string]: unknown }) => {
    content.replaceChildren();
    if (message.type === 'cart') {
      const lines = message.lines as { label: string; qty: number; amount: number }[];
      if (lines.length === 0) {
        content.append(el('p', 'display-hero', ops.state.branding.welcome || 'Welcome'));
        return;
      }
      const list = el('div', 'display-cart');
      for (const line of lines) {
        const row = el('div', 'display-line');
        row.append(el('span', '', `${line.qty}× ${line.label}`), el('strong', '', money(line.amount)));
        list.append(row);
      }
      if (message.discount) {
        const row = el('div', 'display-line');
        row.append(el('span', '', 'Discount'), el('strong', '', `−${money(message.discount as number)}`));
        list.append(row);
      }
      content.append(list, el('p', 'display-total', money(message.total as number)));
    } else if (message.type === 'qris') {
      content.append(el('p', 'display-label', 'Scan to pay'), qrCanvas(message.qr as string, 420), el('p', 'display-total', money(message.amount as number)));
    } else if (message.type === 'paid') {
      const tickets = message.tickets as string[];
      content.append(el('p', 'display-label', 'Thank you'), el('p', 'display-total', money(message.total as number)));
      if (tickets.length) content.append(el('p', 'display-label', 'Your queue number'), el('p', 'display-queue', tickets.join(', ')));
    } else {
      content.append(el('p', 'display-hero', ops.state.branding.welcome || 'Welcome'));
    }
  };
  show({ type: 'idle' });
  const channel = displayChannel(ops);
  if (channel) channel.onmessage = (event) => show(event.data);
}

/** A clock for the corner of a screen, ticking each minute. */
function clock(): HTMLElement {
  const time = el('time', 'display-clock');
  const tick = () => {
    const now = new Date();
    time.textContent = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    time.dateTime = now.toISOString();
  };
  tick();
  setInterval(tick, 10_000);
  return time;
}

/**
 * The waiting-area TV, read from across the room: the number just called fills an ink card, the
 * three before it sit under it, and each booth lists who is next.
 */
function queueScreen(ops: Ops, content: HTMLElement, head: HTMLElement): void {
  head.append(el('span', 'display-head-kicker', 'Antrean foto'), clock());
  const draw = () => {
    const { tickets } = ops.state;
    const booths = ops.sites.points.filter((point) => point.active);
    const called = tickets.filter((ticket) => ticket.status === 'called').sort((a, b) => (b.calledAt ?? 0) - (a.calledAt ?? 0));
    const [latest, ...earlier] = called;

    const now = el('section', 'tv-now');
    now.append(el('p', 'tv-kicker', 'Sekarang dipanggil'));
    if (latest) {
      now.append(el('p', 'tv-now-number', latest.number), el('p', 'tv-now-booth', `Silakan ke ${ops.boothName(latest.calledBoothId)}`));
    } else {
      now.append(el('p', 'tv-now-idle', 'Belum ada nomor dipanggil'), el('p', 'tv-now-booth tv-now-booth--muted', 'Nomor Anda muncul di sini saat booth siap.'));
    }
    const recent = el('div', 'tv-recent');
    for (const ticket of earlier.slice(0, 3)) {
      const card = el('div', 'tv-recent-card');
      card.append(el('span', 'tv-recent-number', ticket.number), el('span', 'tv-recent-booth', ops.boothName(ticket.calledBoothId)));
      recent.append(card);
    }
    const left = el('div', 'tv-main');
    left.append(now);
    if (recent.childElementCount) left.append(recent);

    const next = el('section', 'tv-next');
    next.append(el('p', 'tv-kicker tv-kicker--dark', 'Berikutnya'));
    for (const booth of booths) {
      const waiting = queueFor(tickets, booth.id).filter((ticket) => ticket.checkedIn);
      const row = el('div', 'tv-booth');
      const title = el('div', 'tv-booth-head');
      title.append(el('span', 'tv-booth-name', booth.name), el('span', 'tv-booth-count', waiting.length ? `${waiting.length} menunggu` : 'Kosong'));
      const chips = el('div', 'tv-chips');
      for (const ticket of waiting.slice(0, 4)) chips.append(el('span', 'tv-chip', ticket.number));
      if (waiting.length > 4) chips.append(el('span', 'tv-chip tv-chip--more', `+${waiting.length - 4}`));
      if (!waiting.length) chips.append(el('span', 'tv-chip tv-chip--empty', 'Langsung masuk'));
      row.append(title, chips);
      next.append(row);
    }
    if (!booths.length) next.append(el('p', 'tv-booth-count', 'Belum ada booth aktif.'));

    const grid = el('div', 'tv-grid');
    grid.append(left, next);
    content.replaceChildren(grid, el('p', 'tv-foot', 'Mau foto AI bareng rombongan? Scan QR tiket Anda di kiosk.'));
  };
  draw();
  let last = called();
  function called(): string {
    return ops.state.tickets.filter((t) => t.status === 'called').map((t) => `${t.id}:${t.recalls}`).join();
  }
  ops.store.subscribe(() => {
    // A new call or a re-call flashes the ink card so heads turn to the TV.
    const latest = called();
    draw();
    if (latest !== last) {
      content.classList.remove('tv-flash');
      void content.offsetWidth;
      content.classList.add('tv-flash');
    }
    last = latest;
  });
}

function checkInScreen(ops: Ops, content: HTMLElement, token: string): void {
  const ticket = ops.state.tickets.find((entry) => entry.token === token);
  if (!ticket) {
    content.append(el('p', 'display-hero', 'Ticket not found'), el('p', 'display-label', 'Ask the cashier for help.'));
    return;
  }
  const draw = () => {
    const current = ops.state.tickets.find((entry) => entry.token === token)!;
    content.replaceChildren(el('p', 'display-label', 'Your ticket'), el('p', 'display-queue', current.number));
    if (current.status === 'called') content.append(el('p', 'display-hero', `Go to ${ops.boothName(current.calledBoothId)}`));
    else if (current.status !== 'waiting') content.append(el('p', 'display-label', `This ticket is ${current.status}.`));
    else if (current.checkedIn) content.append(el('p', 'display-label', `Checked in. ${aheadOf(ops.state.tickets, current.id)} ahead of you.`));
    else {
      const button = el('button', 'btn btn-primary btn-lg', "I'm here, check me in");
      button.type = 'button';
      button.addEventListener('click', () => ops.checkIn(token));
      content.append(button);
    }
  };
  draw();
  ops.store.subscribe(draw);
}

async function galleryScreen(ops: Ops, content: HTMLElement, sessions: BoothSession[], missing: string | null): Promise<void> {
  if (missing || sessions.length === 0) {
    content.append(
      el('p', 'display-hero', missing ?? 'No photos yet'),
      el('p', 'display-label', 'In this build the photos stay on the booth that took them. With the cloud backend, this page loads them from any phone.'),
    );
    return;
  }
  const purged = sessions.every((session) => session.purgedAt);
  if (purged) {
    content.append(el('p', 'display-hero', 'These photos were deleted'), el('p', 'display-label', `Photos are kept for ${ops.state.settings.retentionDays} days.`));
    return;
  }
  const shots: Shot[] = (await Promise.all(sessions.map((session) => getShots(session.shotIds)))).flat();
  const consent = sessions.every((session) => session.consent);

  // The consent gate: sharing to social media needs the customer's yes, given at the booth or here.
  let agreed = consent;
  const gate = el('label', 'consent-gate');
  const box = el('input');
  box.type = 'checkbox';
  box.checked = agreed;
  box.addEventListener('change', () => {
    agreed = box.checked;
    for (const button of content.querySelectorAll<HTMLButtonElement>('[data-share]')) button.disabled = !agreed;
  });
  gate.append(box, ' I agree to share these photos publicly');

  const grid = el('div', 'gallery-public');
  for (const shot of shots) {
    const card = el('figure', 'public-shot');
    const url = URL.createObjectURL(shot.blob);
    const media = isMotion(shot) ? Object.assign(el('video'), { src: url, controls: true, playsInline: true, loop: true }) : Object.assign(el('img'), { src: url, alt: '' });
    const actions = el('figcaption', 'public-actions');
    const save = el('button', 'btn btn-outline btn-sm', 'Download');
    save.type = 'button';
    save.addEventListener('click', () => downloadBlob(shot.blob, `photo-${shot.id.slice(0, 6)}.${extensionOf(shot.blob)}`));
    const share = el('button', 'btn btn-primary btn-sm', 'Share');
    share.type = 'button';
    share.dataset.share = '';
    share.disabled = !agreed;
    share.addEventListener('click', async () => {
      const file = new File([shot.blob], `photo.${extensionOf(shot.blob)}`, { type: shot.blob.type });
      try {
        // Instagram and TikTok take a file from the phone's share sheet; there is no web posting API.
        await navigator.share({ files: [file], title: ops.state.branding.brandName });
      } catch (error) {
        if ((error as DOMException).name !== 'AbortError') downloadBlob(shot.blob, file.name);
      }
    });
    actions.append(save, share);
    card.append(media, actions);
    grid.append(card);
  }

  const all = el('button', 'btn btn-secondary', 'Download all');
  all.type = 'button';
  all.addEventListener('click', async () => {
    const files = await Promise.all(shots.map(async (shot, index) => ({ name: `photo-${index + 1}.${extensionOf(shot.blob)}`, data: new Uint8Array(await shot.blob.arrayBuffer()) })));
    downloadBlob(new Blob([zip(files) as BlobPart], { type: 'application/zip' }), 'photos.zip');
  });

  const { branding } = ops.state;
  const social = el('nav', 'public-social');
  for (const [label, url] of [['Instagram', branding.instagram], ['TikTok', branding.tiktok], ['Website', branding.website]]) {
    if (!url) continue;
    const link = el('a', 'btn btn-ghost btn-sm', label);
    link.href = url.startsWith('http') ? url : `https://${url}`;
    link.target = '_blank';
    link.rel = 'noopener';
    social.append(link);
  }
  content.append(el('p', 'display-label', branding.thanks || 'Your photos'), gate, all, grid, social);
}
