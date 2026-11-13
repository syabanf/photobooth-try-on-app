// The setup guide's checklist: what a new venue fills in, in the order that works, and whether
// each step is done. Pure, so the guide page and the dashboard read the same answer.

import type { Sites } from '../account/model';
import type { OpsState } from './model';

export type SetupStepId = 'locations' | 'device' | 'prices' | 'camera' | 'printer' | 'payments' | 'branding' | 'frames' | 'team';

export interface SetupStep {
  id: SetupStepId;
  title: string;
  detail: string;
  done: boolean;
  /** What is still missing, in a few words, when the step is not done. */
  missing: string;
  /** Optional steps never hold up "ready to open". */
  optional: boolean;
}

const names = (points: Sites['points']) => points.map((point) => point.name).join(', ');

export function setupSteps(state: OpsState, sites: Sites, devicePoint: string | null): SetupStep[] {
  const booths = sites.points.filter((point) => point.active);
  const without = (has: (boothId: string) => boolean) => booths.filter((point) => !has(point.id));
  const unpriced = without((id) => state.booths.some((profile) => profile.pointId === id));
  const noCamera = without((id) => state.cameras.some((profile) => profile.boothId === id));
  const noPrinter = without((id) => state.printers.some((printer) => printer.boothIds.includes(id)));
  const { gateway } = state.settings.payments;
  const people = state.staff.filter((person) => person.active);

  return [
    {
      id: 'locations',
      title: 'Locations and booths',
      detail: 'Where the business runs, and each booth, gate or kiosk standing there.',
      done: booths.length > 0,
      missing: 'No booth yet',
      optional: false,
    },
    {
      id: 'device',
      title: 'Link this device to its booth',
      detail: 'A device linked to a booth opens on the customer flow, prints there and reports its health.',
      done: devicePoint !== null,
      missing: 'This device is not linked',
      optional: true,
    },
    {
      id: 'prices',
      title: 'Booth category and prices',
      detail: 'Each booth’s category sets what a photo strip, GIF, video or print costs there. Click a booth under Booths to confirm its category, time zone and session modes.',
      done: booths.length > 0 && unpriced.length === 0,
      missing: unpriced.length ? `Not confirmed yet: ${names(unpriced)}` : 'Add a booth first',
      optional: false,
    },
    {
      id: 'camera',
      title: 'Camera per booth',
      detail: 'A DSLR by its IP address, a webcam or an IP stream, and what the booth uses it for.',
      done: booths.length > 0 && noCamera.length === 0,
      missing: noCamera.length ? `Not set up: ${names(noCamera)}` : 'Add a booth first',
      optional: false,
    },
    {
      id: 'printer',
      title: 'Printer and paper',
      detail: 'Which printer serves each booth, its paper sizes and the paper left.',
      done: booths.length > 0 && noPrinter.length === 0,
      missing: noPrinter.length ? `No printer: ${names(noPrinter)}` : 'Add a booth first',
      optional: false,
    },
    {
      id: 'payments',
      title: 'Payment gateway',
      detail: 'The merchant ID and client key for QRIS, and which methods the till and the booths take.',
      done: Boolean(gateway.merchantId && gateway.clientKey),
      missing: 'No merchant ID or client key',
      optional: false,
    },
    {
      id: 'branding',
      title: 'Brand',
      detail: 'Logo, colours and the welcome line on the booth, the kiosk, the TV and the photo page.',
      done: Boolean(state.branding.logo),
      missing: 'No logo yet',
      optional: true,
    },
    {
      id: 'frames',
      title: 'Print frames',
      detail: 'Your own artwork around the photos. Without one the booth prints a plain strip.',
      done: state.frames.some((frame) => frame.active),
      missing: 'No frame uploaded',
      optional: true,
    },
    {
      id: 'team',
      title: 'Team',
      detail: 'Cashiers, operators and supervisors, each with a role and a sign-in.',
      done: people.length > 1,
      missing: 'Only the owner so far',
      optional: true,
    },
  ];
}

/** Done and total counts; ready once every required step is done. */
export function setupProgress(steps: readonly SetupStep[]): { done: number; total: number; ready: boolean } {
  return { done: steps.filter((step) => step.done).length, total: steps.length, ready: steps.every((step) => step.done || step.optional) };
}
