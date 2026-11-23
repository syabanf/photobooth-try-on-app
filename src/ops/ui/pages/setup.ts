// The setup guide: everything a new venue fills in, in four stages, each step with its status and
// one button that opens the right form. The dashboard shows the progress until the venue is ready.

import { cameraSetupDialog } from '../../../dslr/setup-dialog';
import { icon } from '../../../icons';
import type { View } from '../../../ui';
import { setupProgress, setupSteps, type SetupStep, type SetupStepId } from '../../setup';
import type { PageContext } from '../router';
import { act, badge, el, page } from '../kit';
import { showDevicesTab } from './devices';
import { showPaymentsTab } from './payments';

const STAGES: { title: string; detail: string; steps: SetupStepId[] }[] = [
  { title: 'Tempat', detail: 'Lokasi usaha dan perangkat mana yang berdiri di mana.', steps: ['locations', 'device', 'kiosk'] },
  { title: 'Penjualan', detail: 'Harga dan cara pelanggan membayar.', steps: ['prices', 'payments'] },
  { title: 'Perangkat keras', detail: 'Kamera dan printer di setiap booth.', steps: ['camera', 'printer'] },
  { title: 'Tampilan dan tim', detail: 'Merek Anda di setiap layar, dan orang yang menjalankannya.', steps: ['branding', 'frames', 'team'] },
];

/** Opens a page and, when it has one, the section the step lives in. */
function openAt(nav: (view: View) => void, view: View, anchor?: string): void {
  nav(view);
  if (anchor) requestAnimationFrame(() => document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

export function renderSetup({ ops, nav, redraw }: PageContext): HTMLElement {
  const steps = setupSteps(ops.state, ops.sites, ops.hooks.devicePointId());
  const progress = setupProgress(steps);
  const root = page('Panduan setup', 'Semua yang perlu disiapkan sebelum pelanggan datang, berurutan. Setiap langkah membuka formulirnya sendiri dan tercentang otomatis setelah diisi.');

  const actions: Record<SetupStepId, () => void> = {
    locations: () => nav('sites'),
    device: () => document.dispatchEvent(new Event('vto:pick-device')),
    kiosk: () => nav('queue'),
    prices: () => openAt(nav, 'settings', 'settings-booths'),
    camera: () => {
      // Straight to the camera setup of the first booth still without one.
      const booth = ops.sites.points.find((point) => point.active && !ops.state.cameras.some((profile) => profile.boothId === point.id));
      if (booth) cameraSetupDialog(ops, booth.id, redraw);
      else {
        showDevicesTab('cameras');
        nav('devices');
      }
    },
    printer: () => {
      showDevicesTab('printers');
      nav('devices');
    },
    payments: () => {
      showPaymentsTab('gateway');
      nav('payments');
    },
    branding: () => nav('branding'),
    frames: () => nav('frames'),
    team: () => nav('staff'),
  };
  const labels: Record<SetupStepId, string> = { locations: 'Tambah lokasi', device: 'Hubungkan perangkat', kiosk: 'Buka antrean', prices: 'Atur harga', camera: 'Atur kamera', printer: 'Tambah printer', payments: 'Atur pembayaran', branding: 'Buka merek', frames: 'Unggah bingkai', team: 'Undang tim' };

  // ---------- progress ----------
  const next = steps.find((step) => !step.done && !step.optional) ?? steps.find((step) => !step.done);
  const hero = el('section', 'setup-hero');
  const text = el('div', 'setup-hero-text');
  text.append(
    el('p', 'setup-kicker', progress.ready ? 'Siap buka' : 'Sedang disiapkan'),
    el('p', 'setup-count', `${progress.done} dari ${progress.total} selesai`),
    el('p', 'setup-hero-desc', progress.ready ? 'Semua langkah wajib sudah selesai. Buka kiosk dan TV dari halaman Antrean, dan buka booth dari perangkatnya masing-masing.' : `Berikutnya: ${next?.title ?? ''}. Langkah opsional tidak menahan pembukaan.`),
  );
  const bar = el('div', 'setup-bar');
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', String(progress.total));
  bar.setAttribute('aria-valuenow', String(progress.done));
  const fill = el('span', 'setup-bar-fill');
  fill.style.width = `${(progress.done / progress.total) * 100}%`;
  bar.append(fill);
  text.append(bar);
  hero.append(text);
  if (progress.ready) hero.append(act('Buka antrean', 'btn btn-primary', () => nav('queue'), 'queue'));
  else if (next) hero.append(act(labels[next.id], 'btn btn-primary', actions[next.id], 'chevron'));
  root.body.append(hero);

  // ---------- the stages ----------
  let number = 0;
  for (const stage of STAGES) {
    const block = el('section', 'setup-stage');
    const stageSteps = stage.steps.map((id) => steps.find((step) => step.id === id)!);
    const head = el('header', 'setup-stage-head');
    const headText = el('div');
    headText.append(el('h2', 'setup-stage-title', stage.title), el('p', 'card-desc', stage.detail));
    head.append(headText, badge(`${stageSteps.filter((step) => step.done).length} / ${stageSteps.length}`, stageSteps.every((step) => step.done) ? 'ok' : 'muted'));
    const list = el('ol', 'setup-steps');
    for (const step of stageSteps) list.append(row(step, ++number));
    block.append(head, list);
    root.body.append(block);
  }

  function row(step: SetupStep, index: number): HTMLElement {
    const item = el('li', `setup-step${step.done ? ' is-done' : ''}`);
    const mark = el('span', 'setup-step-mark');
    if (step.done) mark.append(icon('check'));
    else mark.textContent = String(index);
    const body = el('div', 'setup-step-text');
    const title = el('p', 'setup-step-title', step.title);
    if (step.optional) title.append(el('span', 'setup-optional', 'Opsional'));
    body.append(title, el('p', 'card-desc', step.done ? step.detail : `${step.missing}. ${step.detail}`));
    const button = act(step.done ? 'Tinjau' : labels[step.id], step.done ? 'btn btn-ghost btn-sm' : 'btn btn-outline btn-sm', actions[step.id]);
    // A step that needs a booth waits for one, so nobody lands on an empty form.
    if (step.blocked) {
      button.disabled = true;
      button.title = 'Tambah booth dulu';
    }
    item.append(mark, body, button);
    return item;
  }

  return root.root;
}

/** The dashboard's setup banner while required steps remain; nothing once the venue is ready. */
export function setupBanner(ops: PageContext['ops'], nav: (view: View) => void): HTMLElement | null {
  if (!ops.can('settings.manage')) return null;
  const progress = setupProgress(setupSteps(ops.state, ops.sites, ops.hooks.devicePointId()));
  if (progress.ready) return null;
  const card = el('div', 'setup-banner');
  const text = el('div');
  text.append(el('p', 'setup-step-title', `Selesaikan setup · ${progress.done} dari ${progress.total} selesai`), el('p', 'card-desc', 'Booth, harga, kamera, printer dan pembayaran harus siap sebelum pelanggan datang.'));
  card.append(text, act('Buka panduan setup', 'btn btn-primary btn-sm', () => nav('setup'), 'chevron'));
  return card;
}
