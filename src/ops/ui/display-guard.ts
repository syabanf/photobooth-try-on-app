// Keeps an unattended screen (the queue TV, the customer screen, the kiosk) running all day: the
// screen stays awake, visitors cannot zoom or long-press it into a menu, and an uncaught error or a
// long uptime reloads the page at a safe moment instead of leaving a frozen screen.

import type { DisplayRoute } from './display-route';

/** A screen reloads once it has run this long and is idle, so memory never piles up over days. */
const FRESH_MS = 6 * 3_600_000;
const startedAt = Date.now();

async function stayAwake(): Promise<void> {
  // Wake Lock exists only on HTTPS and localhost; on the booth network the OS sleep setting rules.
  const lock = (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<unknown> } }).wakeLock;
  if (!lock) return;
  const request = () => lock.request('screen').catch(() => {});
  await request();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void request();
  });
}

/** True when the page has run long enough that the next idle moment should reload it. */
export function dueForReload(): boolean {
  return Date.now() - startedAt > FRESH_MS;
}

export function guardDisplay(route: DisplayRoute): void {
  if (route.kind !== 'queue' && route.kind !== 'customer' && route.kind !== 'kiosk') return;
  document.documentElement.lang = 'id';
  document.body.classList.add('display-unattended');
  document.querySelector('meta[name=viewport]')?.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover');
  document.addEventListener('contextmenu', (event) => event.preventDefault());
  // Safari ignores user-scalable; a pinch arrives as a gesture event.
  document.addEventListener('gesturestart', (event) => event.preventDefault());
  void stayAwake();

  // The TV and the customer screen hold no state of their own: a reload is always safe. The kiosk
  // reloads itself from its start screen (see kiosk.ts), never in the middle of a payment.
  if (route.kind === 'kiosk') return;
  let reloading = false;
  const recover = (reason: unknown) => {
    console.error('Display error, reloading in 10 seconds', reason);
    if (reloading) return;
    reloading = true;
    setTimeout(() => location.reload(), 10_000);
  };
  window.addEventListener('error', (event) => recover(event.error ?? event.message));
  window.addEventListener('unhandledrejection', (event) => recover(event.reason));
  setInterval(() => {
    if (dueForReload()) location.reload();
  }, 600_000);
}
