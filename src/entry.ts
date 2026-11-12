// Picks the bundle for this address: a display screen (TV, kiosk, customer screen, check-in,
// photo page) or the staff app with the camera. A tab locked to a display goes back to it first.

import './style.css';
import { displayRoute } from './ops/ui/display-route';
import { enforceDisplayLock } from './ops/ui/display-lock';

async function boot(): Promise<void> {
  enforceDisplayLock();
  if (displayRoute(location.hash)) {
    const { startDisplay } = await import('./display-main');
    if (await startDisplay()) return;
  }
  await import('./main');
}

void boot();
