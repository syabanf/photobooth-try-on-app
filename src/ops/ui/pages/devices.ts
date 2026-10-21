// Devices: booth health (heartbeat, camera, version), printers and paper, camera profiles, open
// alerts, who hears about them, and the messages sent.

import { formDialog } from '../../../dialogs';
import { APERTURE_STEPS, ISO_STEPS, SHUTTER_STEPS, SimulatedEdsdk } from '../../adapters';
import { ALERT_LABELS, type CameraSettings, type NotifyChannel, type PaperSize, type Printer, type RoutingRule } from '../../model';
import { PAPER, PAPER_SIZES, paperState } from '../../printing';
import { ALERT_KINDS, isOnline } from '../../telemetry';
import type { PageContext } from '../router';
import { act, badge, dateTime, el, notice, page, parseAmount, pills, section, table } from '../kit';

type Tab = 'health' | 'printers' | 'cameras' | 'alerts' | 'routing' | 'messages';
const view = { tab: 'health' as Tab };

export function renderDevices({ ops, redraw }: PageContext): HTMLElement {
  const { state } = ops;
  const root = page('Devices', 'Booths report a heartbeat, their camera and their version. Printers count paper, and alerts reach the people on each branch’s rules.');
  const open = state.alerts.filter((alert) => !alert.resolvedAt);
  root.body.append(
    pills(
      [
        { value: 'health', label: 'Booths' },
        { value: 'printers', label: 'Printers' },
        { value: 'cameras', label: 'Cameras' },
        { value: 'alerts', label: open.length ? `Alerts (${open.length})` : 'Alerts' },
        { value: 'routing', label: 'Alert routing' },
        { value: 'messages', label: 'Messages sent' },
      ] as const,
      view.tab,
      (tab) => {
        view.tab = tab;
        redraw();
      },
    ),
  );
  const booths = ops.visibleBooths();
  const device = ops.hooks.devicePointId();

  if (view.tab === 'health') {
    root.body.append(
      table(
        [
          { label: 'Booth', cell: (point) => `${point.name}${point.id === device ? ' (this device)' : ''}` },
          { label: 'Branch', cell: (point) => ops.branchName(point.locationId) },
          {
            label: 'Status',
            cell: (point) => {
              const health = state.health.find((entry) => entry.boothId === point.id);
              if (!health) return badge('Never reported', 'muted');
              return isOnline(health, Date.now()) ? badge('Online', 'ok') : badge('Offline', 'error');
            },
          },
          { label: 'Last heartbeat', cell: (point) => dateTime(state.health.find((entry) => entry.boothId === point.id)?.lastHeartbeat) },
          {
            label: 'Camera',
            cell: (point) => {
              const health = state.health.find((entry) => entry.boothId === point.id);
              if (!health) return '—';
              if (!health.cameraConnected) return badge('Disconnected', 'error');
              return health.cameraBattery === null ? badge('Connected', 'ok') : badge(`Battery ${health.cameraBattery}%`, health.cameraBattery <= 20 ? 'warn' : 'ok');
            },
          },
          { label: 'Version', cell: (point) => ops.installedVersion(point.id) },
        ],
        booths,
        { empty: 'Add booths on the Locations page.' },
      ),
      el('p', 'field-hint', 'A booth counts as offline two minutes after its last heartbeat. The device linked to a booth sends one every 30 seconds while the app is open.'),
    );
  } else if (view.tab === 'printers') {
    root.actions.append(act('Add printer', 'btn btn-primary', () => editPrinter(ops), 'plus'));
    root.body.append(
      table(
        [
          { label: 'Printer', cell: (printer) => `${printer.name} · ${printer.brand === 'dnp' ? 'DNP' : 'Other'}` },
          { label: 'Booths', cell: (printer) => printer.boothIds.map((id) => ops.boothName(id)).join(', ') || '—' },
          { label: 'Sizes', cell: (printer) => printer.sizes.join(', ') },
          {
            label: 'Paper',
            className: 'num',
            cell: (printer) => {
              const state = paperState(printer);
              return badge(`${printer.paperLeft} left`, state === 'ok' ? 'ok' : state === 'low' ? 'warn' : 'error');
            },
          },
          { label: 'Status', cell: (printer) => (printer.status === 'ok' ? badge('Ready', 'ok') : badge(printer.error || printer.status, 'error')) },
          {
            label: '',
            className: 'actions',
            cell: (printer) => {
              const box = el('div', 'row-actions');
              box.append(
                act(printer.brand === 'dnp' ? 'Read count' : 'Count paper', 'btn btn-ghost btn-sm', () => paperDialog(ops, printer)),
                act(printer.status === 'ok' ? 'Simulate error' : 'Clear error', 'btn btn-ghost btn-sm', () =>
                  ops.edit('devices.manage', 'printer.status', `${printer.name}: ${printer.status === 'ok' ? 'error reported' : 'back to ready'}.`, (draft) => {
                    const target = draft.printers.find((entry) => entry.id === printer.id)!;
                    target.status = printer.status === 'ok' ? 'error' : 'ok';
                    target.error = printer.status === 'ok' ? 'Ribbon end' : '';
                  }),
                ),
              );
              return box;
            },
          },
        ],
        state.printers,
        { empty: 'No printers yet. Add one per booth, or share one between booths.', onRow: (printer) => editPrinter(ops, printer) },
      ),
      el('p', 'field-hint', 'DNP printers report paper left through their SDK. Other brands start from a manual count that goes down with each print. Alerts fire at the low threshold.'),
    );
  } else if (view.tab === 'cameras') {
    root.body.append(camerasTab(ops, booths, device, redraw));
  } else if (view.tab === 'alerts') {
    root.body.append(
      table(
        [
          { label: 'Opened', cell: (alert) => dateTime(alert.openedAt) },
          { label: 'Alert', cell: (alert) => badge(ALERT_LABELS[alert.kind], alert.resolvedAt ? 'muted' : 'error') },
          { label: 'What', cell: (alert) => alert.message },
          { label: 'Branch', cell: (alert) => ops.branchName(alert.branchId) },
          { label: 'Resolved', cell: (alert) => (alert.resolvedAt ? dateTime(alert.resolvedAt) : badge('Open', 'warn')) },
        ],
        [...state.alerts].reverse().slice(0, 200),
        { empty: 'No alerts. Paper, printer errors, cameras and silent booths raise them.' },
      ),
    );
  } else if (view.tab === 'routing') {
    root.actions.append(act('Add rule', 'btn btn-primary', () => editRule(ops), 'plus'));
    root.body.append(
      el('p', 'card-desc', 'With no rule for a branch, every alert pops up on the booth and goes by email and WhatsApp to the owner and the staff on duty there. A branch rule replaces that for the alerts it lists.'),
      table(
        [
          { label: 'Branch', cell: (rule) => (rule.branchId ? ops.branchName(rule.branchId) : 'Every branch') },
          { label: 'Alerts', cell: (rule) => rule.kinds.map((kind) => ALERT_LABELS[kind]).join(', ') },
          { label: 'Channels', cell: (rule) => rule.channels.map((c) => ({ popup: 'Booth popup', email: 'Email', whatsapp: 'WhatsApp' })[c]).join(', ') },
          { label: 'People', cell: (rule) => rule.recipients.map((r) => (r === 'owner' ? 'Owner' : r === 'on-duty' ? 'On duty' : state.staff.find((p) => p.id === r)?.name ?? '?')).join(', ') },
        ],
        state.rules,
        { empty: 'Using the default rule.', onRow: (rule) => editRule(ops, rule) },
      ),
    );
  } else {
    root.body.append(
      el('p', 'card-desc', 'Emails and WhatsApp messages the app sent: alerts, queue calls, receipts and photo links. This build records them here; the server sends them through your email and WhatsApp Business providers.'),
      table(
        [
          { label: 'When', cell: (message) => dateTime(message.at) },
          { label: 'Channel', cell: (message) => badge(message.channel === 'email' ? 'Email' : 'WhatsApp', 'info') },
          { label: 'To', cell: (message) => message.to },
          { label: 'Message', cell: (message) => message.body },
        ],
        state.notifications.slice(0, 200),
        { empty: 'Nothing sent yet.' },
      ),
    );
  }
  return root.root;
}

function editPrinter(ops: PageContext['ops'], printer?: Printer): void {
  formDialog({
    title: printer ? `Edit ${printer.name}` : 'Add printer',
    submitLabel: 'Save',
    fields: [
      { name: 'name', label: 'Name', value: printer?.name ?? '', placeholder: 'DNP DS-RX1HS' },
      { name: 'brand', label: 'Brand', value: printer?.brand ?? 'dnp', options: [{ value: 'dnp', label: 'DNP (paper count from the SDK)' }, { value: 'other', label: 'Other (manual count)' }] },
      { name: 'boothIds', label: 'Booths', value: printer?.boothIds ?? [], options: ops.visibleBooths().map((point) => ({ value: point.id, label: point.name })), hint: 'Tick several to share one printer between booths.' },
      { name: 'sizes', label: 'Sizes', value: printer?.sizes ?? ['4R'], options: PAPER_SIZES.map((size) => ({ value: size, label: PAPER[size].label })) },
      { name: 'paperLeft', label: 'Paper left', value: String(printer?.paperLeft ?? 400), type: 'number' },
      { name: 'lowThreshold', label: 'Alert below', value: String(printer?.lowThreshold ?? 50), type: 'number' },
    ],
    danger: printer ? { label: 'Delete', run: (close) => { ops.edit('devices.manage', 'printer.delete', `Removed printer ${printer.name}.`, (draft) => { draft.printers = draft.printers.filter((entry) => entry.id !== printer.id); }); close(); } } : undefined,
    async submit(values) {
      const name = String(values.name).trim();
      const boothIds = values.boothIds as string[];
      const sizes = values.sizes as PaperSize[];
      if (!name) throw new Error('Enter a name.');
      if (boothIds.length === 0) throw new Error('Pick at least one booth.');
      if (sizes.length === 0) throw new Error('Pick at least one size.');
      ops.edit('devices.manage', 'printer.save', `Saved printer ${name}.`, (draft) => {
        const fields = { name, brand: values.brand as Printer['brand'], boothIds, sizes, paperLeft: parseAmount(String(values.paperLeft)), lowThreshold: parseAmount(String(values.lowThreshold)) };
        const existing = draft.printers.find((entry) => entry.id === printer?.id);
        if (existing) Object.assign(existing, fields);
        else draft.printers.push({ id: ops.store.id(), status: 'ok', error: '', ...fields });
      });
      ops.checkAlerts();
    },
  });
}

/** DNP: the SDK reading. Others: the operator counts after loading a roll or a pack. */
function paperDialog(ops: PageContext['ops'], printer: Printer): void {
  formDialog({
    title: printer.brand === 'dnp' ? `${printer.name}: paper reading` : `${printer.name}: count paper`,
    description: printer.brand === 'dnp' ? 'Enter what the DNP status tool shows. The native agent reads this from the SDK on its own.' : 'Count the sheets after loading paper. Each print takes one off.',
    submitLabel: 'Save',
    fields: [{ name: 'count', label: 'Sheets left', value: String(printer.paperLeft), type: 'number' }],
    async submit(values) {
      const count = parseAmount(String(values.count));
      ops.edit('devices.manage', 'printer.paper', `${printer.name}: ${count} sheets.`, (draft) => {
        draft.printers.find((entry) => entry.id === printer.id)!.paperLeft = count;
      });
      ops.checkAlerts();
    },
  });
}

function editRule(ops: PageContext['ops'], rule?: RoutingRule): void {
  formDialog({
    title: rule ? 'Edit alert rule' : 'Add alert rule',
    submitLabel: 'Save',
    fields: [
      { name: 'branchId', label: 'Branch', value: rule?.branchId ?? '', options: [{ value: '', label: 'Every branch' }, ...ops.visibleBranches().map((branch) => ({ value: branch.id, label: branch.name }))] },
      { name: 'kinds', label: 'Alerts', value: rule?.kinds ?? ALERT_KINDS, options: ALERT_KINDS.map((kind) => ({ value: kind, label: ALERT_LABELS[kind] })) },
      { name: 'channels', label: 'Channels', value: rule?.channels ?? ['popup', 'whatsapp'], options: [{ value: 'popup', label: 'Booth popup' }, { value: 'email', label: 'Email' }, { value: 'whatsapp', label: 'WhatsApp' }] },
      { name: 'recipients', label: 'People', value: rule?.recipients ?? ['owner', 'on-duty'], options: [{ value: 'owner', label: 'Owner' }, { value: 'on-duty', label: 'Staff on duty' }, ...ops.state.staff.map((person) => ({ value: person.id, label: person.name }))] },
    ],
    danger: rule ? { label: 'Delete', run: (close) => { ops.edit('devices.manage', 'rule.delete', 'Deleted an alert rule.', (draft) => { draft.rules = draft.rules.filter((entry) => entry.id !== rule.id); }); close(); } } : undefined,
    async submit(values) {
      const kinds = values.kinds as RoutingRule['kinds'];
      const channels = values.channels as NotifyChannel[];
      if (kinds.length === 0 || channels.length === 0) throw new Error('Pick at least one alert and one channel.');
      ops.edit('devices.manage', 'rule.save', 'Saved an alert rule.', (draft) => {
        const fields = { branchId: String(values.branchId) || null, kinds, channels, recipients: values.recipients as string[] };
        const existing = draft.rules.find((entry) => entry.id === rule?.id);
        if (existing) Object.assign(existing, fields);
        else draft.rules.push({ id: ops.store.id(), ...fields });
      });
    },
  });
}

function settingsFields(prefix: string, settings: CameraSettings) {
  return [
    { name: `${prefix}iso`, label: 'ISO', value: String(settings.iso), options: ISO_STEPS.map((v) => ({ value: String(v), label: String(v) })) },
    { name: `${prefix}aperture`, label: 'Aperture', value: String(settings.aperture), options: APERTURE_STEPS.map((v) => ({ value: String(v), label: `f/${v}` })) },
    { name: `${prefix}shutter`, label: 'Shutter', value: settings.shutter, options: SHUTTER_STEPS.map((v) => ({ value: v, label: v })) },
    { name: `${prefix}whiteBalance`, label: 'White balance', value: settings.whiteBalance, options: ['auto', 'daylight', 'cloudy', 'tungsten', 'fluorescent', 'flash'].map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) })) },
    { name: `${prefix}exposureComp`, label: 'Exposure compensation', value: String(settings.exposureComp), options: [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2].map((v) => ({ value: String(v), label: `${v > 0 ? '+' : ''}${v} EV` })) },
    { name: `${prefix}pictureStyle`, label: 'Picture style', value: settings.pictureStyle, options: ['standard', 'portrait', 'landscape', 'neutral', 'faithful', 'monochrome'].map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) })) },
  ];
}

function readSettings(prefix: string, values: Record<string, unknown>): CameraSettings {
  return {
    iso: Number(values[`${prefix}iso`]),
    aperture: Number(values[`${prefix}aperture`]),
    shutter: String(values[`${prefix}shutter`]),
    whiteBalance: values[`${prefix}whiteBalance`] as CameraSettings['whiteBalance'],
    exposureComp: Number(values[`${prefix}exposureComp`]),
    pictureStyle: values[`${prefix}pictureStyle`] as CameraSettings['pictureStyle'],
  };
}

function camerasTab(ops: PageContext['ops'], booths: ReturnType<PageContext['ops']['visibleBooths']>, device: string | null, redraw: () => void): HTMLElement {
  const box = el('div');
  const source = el('div', 'field-row');
  source.append(
    el('p', 'card-desc', 'This device’s picture: a USB or built-in camera, or an IP camera by its MJPEG or HLS link.'),
    act('Camera source', 'btn btn-outline btn-sm', () => document.dispatchEvent(new Event('vto:pick-camera')), 'camera'),
  );
  box.append(source);
  box.append(
    table(
      [
        { label: 'Booth', cell: (point) => `${point.name}${point.id === device ? ' (this device)' : ''}` },
        { label: 'Camera', cell: (point) => (ops.cameraProfile(point.id).driver === 'edsdk' ? 'Canon (EDSDK)' : 'Webcam') },
        { label: 'Preview', cell: (point) => describeSettings(ops.cameraProfile(point.id).preview) },
        { label: 'Capture', cell: (point) => describeSettings(ops.cameraProfile(point.id).capture) },
        { label: 'BTS camera', cell: (point) => (ops.cameraProfile(point.id).secondaryDeviceId ? 'Recording' : '—') },
      ],
      booths,
      {
        empty: 'Add booths on the Locations page.',
        onRow: async (point) => {
          const profile = ops.cameraProfile(point.id);
          const cameras = (await navigator.mediaDevices?.enumerateDevices?.().catch(() => [])) ?? [];
          const videoInputs = cameras.filter((camera) => camera.kind === 'videoinput');
          formDialog({
            title: `${point.name} camera`,
            description: 'Preview settings run while customers frame themselves; capture settings apply for the shot, then preview comes back. They are re-applied whenever the camera powers up.',
            submitLabel: 'Save',
            fields: [
              { name: 'driver', label: 'Camera', value: profile.driver, options: [{ value: 'webcam', label: 'Webcam (browser)' }, { value: 'edsdk', label: 'Canon DSLR or mirrorless (EDSDK)' }] },
              ...settingsFields('p_', profile.preview).map((field) => ({ ...field, label: `Preview · ${field.label}` })),
              ...settingsFields('c_', profile.capture).map((field) => ({ ...field, label: `Capture · ${field.label}` })),
              {
                name: 'secondaryDeviceId',
                label: 'Behind-the-scenes camera',
                value: profile.secondaryDeviceId,
                options: [{ value: '', label: 'None' }, ...videoInputs.map((camera, index) => ({ value: camera.deviceId, label: camera.label || `Camera ${index + 1}` }))],
                hint: 'A second camera that records every session as a BTS clip, for CCTV or social content.',
              },
            ],
            async submit(values) {
              ops.saveCameraProfile({ boothId: point.id, driver: values.driver as 'webcam' | 'edsdk', preview: readSettings('p_', values), capture: readSettings('c_', values), secondaryDeviceId: String(values.secondaryDeviceId) });
            },
          });
        },
      },
    ),
  );
  const camera = ops.camera;
  if (camera instanceof SimulatedEdsdk) {
    const sim = section('EDSDK simulator', 'Stands in for the Canon body on this device, so health alerts and power-up re-apply can be tried.');
    const state = camera.state();
    sim.body.append(el('p', 'card-desc', `${state.connected ? 'On' : 'Off'}${state.battery !== null ? ` · battery ${state.battery}%` : ''}${state.applied ? ` · ${state.applied.profile} profile applied` : ''}`));
    sim.actions.append(
      act(state.connected ? 'Power off' : 'Power on', 'btn btn-outline btn-sm', () => {
        if (state.connected) camera.powerOff();
        else camera.powerOn();
        redraw();
      }),
      act('Battery 15%', 'btn btn-ghost btn-sm', () => {
        camera.setBattery(15);
        redraw();
      }),
      act('Battery 100%', 'btn btn-ghost btn-sm', () => {
        camera.setBattery(100);
        notice('Battery full.', 'ok');
        redraw();
      }),
    );
    box.append(sim.root);
  }
  return box;
}

function describeSettings(settings: CameraSettings): string {
  return `ISO ${settings.iso} · f/${settings.aperture} · ${settings.shutter} · ${settings.whiteBalance} · ${settings.exposureComp > 0 ? '+' : ''}${settings.exposureComp} EV`;
}
