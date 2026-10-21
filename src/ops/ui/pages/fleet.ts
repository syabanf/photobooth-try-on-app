// Fleet: OTA releases with staged rollout and rollback, remote support sessions, and the offline
// queue that syncs sales and sessions to the cloud.

import { formDialog } from '../../../dialogs';
import { compareVersions } from '../../fleet';
import { APP_VERSION } from '../../ops';
import type { PageContext } from '../router';
import { act, badge, confirmAct, dateTime, el, notice, page, section, statRow, table } from '../kit';

export function renderFleet({ ops, redraw }: PageContext): HTMLElement {
  const { state } = ops;
  const root = page('Fleet', 'Ship updates to a share of booths first, widen when they behave, and roll back with one tap. Support sessions and sync status live here too.');
  const device = ops.hooks.devicePointId();
  const booths = ops.visibleBooths();

  // ---------- releases ----------
  const releases = section('Releases', `Every booth runs ${APP_VERSION} unless a release reaches it. A booth's bucket is fixed per release, so widening a rollout only adds booths.`);
  releases.actions.append(
    act('New release', 'btn btn-primary btn-sm', () =>
      formDialog({
        title: 'New release',
        submitLabel: 'Stage',
        fields: [
          { name: 'version', label: 'Version', value: '', placeholder: '0.3.0' },
          { name: 'notes', label: 'Notes', value: '', type: 'textarea' },
          { name: 'percent', label: 'Booths that take it (%)', value: '10', type: 'number', hint: 'Start small, such as 10%, then raise it.' },
        ],
        async submit(values) {
          const version = String(values.version).trim();
          if (!/^\d+(\.\d+){1,3}$/.test(version)) throw new Error('Use a version like 0.3.0.');
          if (state.releases.some((release) => release.version === version)) throw new Error(`${version} exists already.`);
          const percent = Math.max(0, Math.min(100, Number(values.percent)));
          ops.edit('fleet.manage', 'release.stage', `Staged ${version} to ${percent}% of booths.`, (draft) => {
            draft.releases.push({ id: ops.store.id(), version, notes: String(values.notes).trim(), percent, status: 'staged', createdAt: Date.now() });
          });
        },
      }),
    'rocket'),
  );
  releases.body.append(
    table(
      [
        { label: 'Version', cell: (release) => release.version },
        { label: 'Rollout', cell: (release) => (release.status === 'rolled-back' ? badge('Rolled back', 'error') : badge(`${release.percent}% of booths`, release.percent === 100 ? 'ok' : 'info')) },
        { label: 'Booths on it', className: 'num', cell: (release) => String(booths.filter((point) => ops.targetFor(point.id) === release.version).length) },
        { label: 'Notes', cell: (release) => release.notes || '—' },
        {
          label: '',
          className: 'actions',
          cell: (release) => {
            const box = el('div', 'row-actions');
            if (release.status !== 'rolled-back') {
              if (release.percent < 100) {
                box.append(act(`Widen to ${release.percent < 50 ? 50 : 100}%`, 'btn btn-ghost btn-sm', () =>
                  ops.edit('fleet.manage', 'release.widen', `Widened ${release.version}.`, (draft) => {
                    const target = draft.releases.find((entry) => entry.id === release.id)!;
                    target.percent = target.percent < 50 ? 50 : 100;
                  }),
                ));
              }
              box.append(confirmAct('Roll back', 'btn btn-ghost btn-sm btn-danger', `Roll back ${release.version}?`, 'Booths on it go back to the release before it at their next check.', () =>
                ops.edit('fleet.manage', 'release.rollback', `Rolled back ${release.version}.`, (draft) => {
                  draft.releases.find((entry) => entry.id === release.id)!.status = 'rolled-back';
                }),
              ));
            }
            return box;
          },
        },
      ],
      [...state.releases].sort((a, b) => compareVersions(b.version, a.version)),
      { empty: 'No releases staged.' },
    ),
    table(
      [
        { label: 'Booth', cell: (point) => `${point.name}${point.id === device ? ' (this device)' : ''}` },
        { label: 'Installed', cell: (point) => ops.installedVersion(point.id) },
        { label: 'Target', cell: (point) => ops.targetFor(point.id) },
        { label: 'State', cell: (point) => (ops.installedVersion(point.id) === ops.targetFor(point.id) ? badge('Up to date', 'ok') : badge('Update waiting', 'warn')) },
        {
          label: '',
          className: 'actions',
          cell: (point) =>
            point.id === device && ops.installedVersion(point.id) !== ops.targetFor(point.id)
              ? act('Update now', 'btn btn-secondary btn-sm', () => {
                  const version = ops.applyUpdate(point.id);
                  notice(`Updated to ${version}. The agent restarts the app between sessions.`, 'ok');
                })
              : '',
        },
      ],
      booths,
      { empty: 'Add booths on the Locations page.' },
    ),
  );

  // ---------- remote support ----------
  const support = section('Remote support', 'The booth shows a code; support types it in their remote tool to connect. The booth operator must allow it, and every session is logged.');
  support.actions.append(
    act('Request support for this booth', 'btn btn-outline btn-sm', () => {
      if (!device) throw new Error('Link this device to a booth on the Locations page first.');
      const code = String(Math.floor(100_000 + Math.random() * 900_000));
      ops.edit('fleet.manage', 'support.request', `Support requested for ${ops.boothName(device)} with code ${code}.`, (draft) => {
        draft.support.unshift({ id: ops.store.id(), boothId: device, code, requestedBy: ops.actor()?.name ?? '', status: 'waiting', startedAt: Date.now(), log: [`${new Date().toLocaleTimeString()} requested`] });
      });
    }, 'support'),
  );
  support.body.append(
    table(
      [
        { label: 'Booth', cell: (entry) => ops.boothName(entry.boothId) },
        { label: 'Code', cell: (entry) => el('span', 'code', entry.code) },
        { label: 'Status', cell: (entry) => badge(entry.status === 'connected' ? 'Connected' : entry.status === 'waiting' ? 'Waiting for support' : 'Ended', entry.status === 'connected' ? 'warn' : entry.status === 'waiting' ? 'info' : 'muted') },
        { label: 'Started', cell: (entry) => dateTime(entry.startedAt) },
        { label: 'Log', cell: (entry) => entry.log.join(' · ') },
        {
          label: '',
          className: 'actions',
          cell: (entry) => {
            const box = el('div', 'row-actions');
            const step = (status: 'connected' | 'ended', note: string) =>
              ops.edit('fleet.manage', `support.${status}`, `Support session ${entry.code}: ${note}.`, (draft) => {
                const target = draft.support.find((s) => s.id === entry.id)!;
                target.status = status;
                target.log.push(`${new Date().toLocaleTimeString()} ${note}`);
                if (status === 'ended') target.endedAt = Date.now();
              });
            if (entry.status === 'waiting') box.append(act('Allow connection', 'btn btn-ghost btn-sm', () => step('connected', 'operator allowed the connection')));
            if (entry.status !== 'ended') box.append(act('End', 'btn btn-ghost btn-sm btn-danger', () => step('ended', 'ended')));
            return box;
          },
        },
      ],
      state.support.slice(0, 50),
      { empty: 'No support sessions.' },
    ),
  );

  // ---------- sync ----------
  const sync = section('Cloud sync', 'Sales, sessions, refunds and shifts are written to a local queue first and leave only when the cloud confirms them, so a dropped connection loses nothing.');
  const pending = ops.outbox.pending();
  sync.body.append(
    statRow([
      { label: 'Connection', value: ops.cloud.online() ? 'Online' : 'Offline', hint: ops.cloud.forcedOffline ? 'Simulated' : 'From the browser' },
      { label: 'Waiting to sync', value: String(pending.length), hint: pending[0]?.lastError ? `Last try: ${pending[0].lastError}` : '' },
      { label: 'Synced', value: String(ops.cloud.received()) },
    ]),
  );
  sync.actions.append(
    act(ops.cloud.forcedOffline ? 'Back online' : 'Simulate offline', 'btn btn-outline btn-sm', async () => {
      ops.cloud.forcedOffline = !ops.cloud.forcedOffline;
      if (!ops.cloud.forcedOffline) await ops.outbox.retryNow();
      redraw();
    }, ops.cloud.forcedOffline ? 'wifi' : 'offline'),
    act('Sync now', 'btn btn-ghost btn-sm', async () => {
      const sent = await ops.outbox.retryNow();
      notice(sent ? `Synced ${sent} ${sent === 1 ? 'item' : 'items'}.` : ops.cloud.online() ? 'Nothing to sync.' : 'Still offline. Items stay queued.', sent ? 'ok' : 'info');
      redraw();
    }, 'refresh'),
  );

  root.body.append(releases.root, support.root, sync.root);
  return root.root;
}
