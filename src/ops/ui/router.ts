// Draws the business pages into #opsView and redraws the open one whenever the store changes,
// waiting while someone is typing in it so a redraw never steals their cursor.

import type { OpsView, View } from '../../ui';
import type { Ops } from '../ops';
import { renderBranding } from './pages/branding';
import { renderDevices } from './pages/devices';
import { renderFleet } from './pages/fleet';
import { renderFrames } from './pages/frames';
import { renderPayments } from './pages/payments';
import { renderPos } from './pages/pos';
import { renderQueue } from './pages/queue';
import { renderReports } from './pages/reports';
import { renderSales } from './pages/sales';
import { renderSettings } from './pages/settings';
import { renderStaff } from './pages/staff';
import { renderVouchers } from './pages/vouchers';
import { el } from './kit';
import { can, type Permission } from '../access';

export interface PageContext {
  ops: Ops;
  nav(view: View): void;
  /** Redraws the page, for local state such as the active tab. */
  redraw(): void;
}

type Render = (context: PageContext) => HTMLElement;

const PAGES: Record<OpsView, { render: Render; permission: Permission }> = {
  pos: { render: renderPos, permission: 'pos.sell' },
  queue: { render: renderQueue, permission: 'queue.run' },
  sales: { render: renderSales, permission: 'history.view' },
  payments: { render: renderPayments, permission: 'history.view' },
  reports: { render: renderReports, permission: 'reports.view' },
  vouchers: { render: renderVouchers, permission: 'vouchers.manage' },
  frames: { render: renderFrames, permission: 'frames.manage' },
  branding: { render: renderBranding, permission: 'branding.manage' },
  devices: { render: renderDevices, permission: 'devices.manage' },
  staff: { render: renderStaff, permission: 'staff.manage' },
  fleet: { render: renderFleet, permission: 'fleet.manage' },
  settings: { render: renderSettings, permission: 'settings.manage' },
};

export interface OpsRouter {
  show(view: OpsView): void;
  hide(): void;
}

export function mountOpsRouter(ops: Ops, nav: (view: View) => void): OpsRouter {
  const container = document.querySelector<HTMLElement>('#opsView')!;
  let current: OpsView | null = null;
  let pending = false;

  const context: PageContext = { ops, nav, redraw: () => draw() };

  function draw(): void {
    pending = false;
    if (!current) return;
    const scroll = container.closest('.main')?.scrollTop ?? 0;
    const page = PAGES[current];
    if (!can(ops.actor(), page.permission)) {
      const locked = el('div', 'card page-card empty');
      locked.append(el('p', 'empty-title', 'Not available for your role'), el('p', 'empty-desc', `${ops.actor()?.name ?? 'This user'} cannot open this page. Switch user on the Staff page or ask an owner.`));
      container.replaceChildren(locked);
      return;
    }
    container.replaceChildren(page.render(context));
    const main = container.closest('.main');
    if (main) main.scrollTop = scroll;
  }

  const typing = () => {
    const active = document.activeElement;
    return !!active && container.contains(active) && active.matches('input:not([type=checkbox]):not([type=radio]), textarea, select');
  };

  // Dialogs live outside the container, so a redraw under one is harmless; only typing holds it.
  ops.store.subscribe(() => {
    if (!current || container.hidden) return;
    if (typing()) pending = true;
    else draw();
  });
  // Catch up once the person stops typing.
  container.addEventListener('focusout', () => setTimeout(() => pending && !typing() && draw()));

  return {
    show(view) {
      current = view;
      draw();
    },
    hide() {
      current = null;
    },
  };
}
