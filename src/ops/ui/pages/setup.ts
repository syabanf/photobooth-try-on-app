// The setup guide: everything a new venue fills in, in four stages, each step with its status and
// one button that opens the right form. The dashboard shows the progress until the venue is ready.

import { cameraSetupDialog } from '../../../dslr/setup-dialog';
import { icon } from '../../../icons';
import type { View } from '../../../ui';
import { setupProgress, setupSteps, type SetupStep, type SetupStepId } from '../../setup';
import type { PageContext } from '../router';
import { act, badge, el, page } from '../kit';
import { showDevicesTab } from './devices';

const STAGES: { title: string; detail: string; steps: SetupStepId[] }[] = [
  { title: 'Venue', detail: 'Where you run and which device stands where.', steps: ['locations', 'device'] },
  { title: 'Selling', detail: 'What things cost and how customers pay.', steps: ['prices', 'payments'] },
  { title: 'Hardware', detail: 'The camera and printer at every booth.', steps: ['camera', 'printer'] },
  { title: 'Look and team', detail: 'Your brand on every screen, and the people who run it.', steps: ['branding', 'frames', 'team'] },
];

/** Opens a page and, when it has one, the section the step lives in. */
function openAt(nav: (view: View) => void, view: View, anchor?: string): void {
  nav(view);
  if (anchor) requestAnimationFrame(() => document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

export function renderSetup({ ops, nav, redraw }: PageContext): HTMLElement {
  const steps = setupSteps(ops.state, ops.sites, ops.hooks.devicePointId());
  const progress = setupProgress(steps);
  const root = page('Setup guide', 'Everything the venue needs before customers arrive, in order. Each step opens the form it needs and ticks itself off once filled in.');

  const actions: Record<SetupStepId, () => void> = {
    locations: () => nav('sites'),
    device: () => document.dispatchEvent(new Event('vto:pick-device')),
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
    payments: () => nav('payments'),
    branding: () => nav('branding'),
    frames: () => nav('frames'),
    team: () => nav('staff'),
  };
  const labels: Record<SetupStepId, string> = { locations: 'Add locations', device: 'Link device', prices: 'Set prices', camera: 'Set up camera', printer: 'Add printer', payments: 'Set up payments', branding: 'Open branding', frames: 'Upload frames', team: 'Invite team' };

  // ---------- progress ----------
  const next = steps.find((step) => !step.done && !step.optional) ?? steps.find((step) => !step.done);
  const hero = el('section', 'setup-hero');
  const text = el('div', 'setup-hero-text');
  text.append(
    el('p', 'setup-kicker', progress.ready ? 'Ready to open' : 'Getting ready'),
    el('p', 'setup-count', `${progress.done} of ${progress.total} done`),
    el('p', 'setup-hero-desc', progress.ready ? 'Every required step is done. Open the kiosk and the TV from Queue, and the booths from their own devices.' : `Next: ${next?.title ?? ''}. Optional steps never hold up opening.`),
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
  if (progress.ready) hero.append(act('Open Queue', 'btn btn-primary', () => nav('queue'), 'queue'));
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
    if (step.optional) title.append(el('span', 'setup-optional', 'Optional'));
    body.append(title, el('p', 'card-desc', step.done ? step.detail : `${step.missing}. ${step.detail}`));
    item.append(mark, body, act(step.done ? 'Review' : labels[step.id], step.done ? 'btn btn-ghost btn-sm' : 'btn btn-outline btn-sm', actions[step.id]));
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
  text.append(el('p', 'setup-step-title', `Finish setting up · ${progress.done} of ${progress.total} done`), el('p', 'card-desc', 'Booths, prices, the camera, the printer and payments need to be in place before customers arrive.'));
  card.append(text, act('Open setup guide', 'btn btn-primary btn-sm', () => nav('setup'), 'chevron'));
  return card;
}
