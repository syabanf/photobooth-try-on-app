// Screens that run on their own from a link: the queue TV, the customer screen, the kiosk, a
// ticket's check-in page and a customer's photo page. They load without the camera, the try-on
// models or the staff menus, so a TV or a phone downloads a fraction of the staff app.

import { browserStore, createLocalBackend } from './account/backend';
import { openRecords } from './ops/big-store';
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
  const account = (await backend.current()) ?? (await backend.business());
  if (!account) {
    document.body.textContent = 'Buka aplikasi staf di perangkat ini dan atur pemilik Dusun Bambu dulu.';
    return true;
  }
  const records = await openRecords((error) => console.error('Could not save to this device.', error));
  // The kiosk sells and prints for a booth: the one in its link, or the one this device belongs to.
  const boothId = route.kind === 'kiosk' ? (route.boothId ?? localStorage.getItem(`vto:device-point:${account.id}`)) : null;
  const ops = new Ops(new OpsStore(records, account.id, account.business), account, { toast: () => {}, devicePointId: () => boothId });
  ops.sites = await backend.sites();
  ops.accounts = backend;
  guardDisplay(route);
  await renderDisplay(ops, route);
  return true;
}
