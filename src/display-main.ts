// Screens that run on their own from a link: the queue TV, the customer screen, the kiosk, a
// ticket's check-in page and a customer's photo page. They load without the camera, the try-on
// models or the staff menus, so a TV or a phone downloads a fraction of the staff app.

import { browserStore, createLocalBackend } from './account/backend';
import { renderRemoteGallery } from './ops/delivery';
import { Ops } from './ops/ops';
import { OpsStore } from './ops/store';
import { displayRoute } from './ops/ui/display-route';
import { guardDisplay } from './ops/ui/display-guard';
import { renderDisplay } from './ops/ui/displays';

const backend = createLocalBackend(browserStore());

export async function startDisplay(): Promise<boolean> {
  const route = displayRoute(location.hash);
  if (!route) return false;
  if (route.kind === 'gallery' && await renderRemoteGallery(route.id)) return true;
  const current = await backend.current();
  const candidates = current ? [current, ...(await backend.workspaces())] : await backend.workspaces();
  // A photo link or ticket belongs to whichever workspace on this device holds its token.
  const holds = (candidateId: string, business: string): boolean => {
    if (route.kind === 'customer' || route.kind === 'queue' || route.kind === 'kiosk') return candidateId === current?.id;
    const saved = new OpsStore(browserStore(), candidateId, business).state;
    const id = 'id' in route ? route.id : '';
    if (route.kind === 'gallery') return saved.sessions.some((session) => session.token === id);
    if (route.kind === 'event') return saved.events.some((event) => event.id === id);
    return saved.tickets.some((ticket) => ticket.token === id);
  };
  const account = candidates.find((candidate) => holds(candidate.id, candidate.business)) ?? current ?? candidates[0];
  if (!account) {
    document.body.textContent = 'Open the app and pick a workspace first.';
    return true;
  }
  // The kiosk sells and prints for a booth: the one in its link, or the one this device belongs to.
  const boothId = route.kind === 'kiosk' ? (route.boothId ?? localStorage.getItem(`vto:device-point:${account.id}`)) : null;
  const ops = new Ops(new OpsStore(browserStore(), account.id, account.business), account, { toast: () => {}, devicePointId: () => boothId });
  ops.sites = await backend.sites();
  ops.accounts = backend;
  guardDisplay(route);
  await renderDisplay(ops, route);
  return true;
}
