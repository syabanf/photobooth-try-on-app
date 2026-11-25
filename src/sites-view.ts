// Master data: the account's locations, the points inside each one, and which point this device is.

import type { AccountBackend } from './account/backend';
import { suggestPointCode, type Account, type Location, type Point, type Sites } from './account/model';
import { confirmDialog, formDialog, openDialog } from './dialogs';
import { actionButton, el, stat, tile } from './dom';
import { icon, iconButton } from './icons';
import { readStored, segmented, writeStored } from './ui';

export interface SitesHandlers {
  /** Captures saved on this device, keyed by point id. */
  captureCounts(): Promise<Map<string, number>>;
  onOpenSites(): void;
  /** This device was linked to a point, moved to another one, or unlinked. */
  onDevicePoint(): void;
  /** Locations or points changed, so other parts of the app can pick up the new lists. */
  onSites?(sites: Sites): void;
}

export interface SitesView {
  refresh(): Promise<void>;
  /** The point this device runs as, so new captures carry it. */
  devicePointId(): string | null;
  /** "Kiosk 1 · Grand Indonesia", for gallery cards. */
  pointLabel(id: string | null | undefined): string | null;
  /** Opens the sheet that picks this device's point. */
  pickDevicePoint(): void;
}

function statusBadge(active: boolean): HTMLElement {
  const badge = el('span', 'badge', active ? 'Aktif' : 'Dijeda');
  badge.title = badge.textContent!;
  if (active) badge.dataset.kind = 'ok';
  return badge;
}

type Layout = 'cards' | 'table';

/** A location with the points to show under it: all of them, or the ones the search matched. */
interface Group {
  location: Location;
  points: Point[];
}

export function mountSitesView(backend: AccountBackend, account: Account, handlers: SitesHandlers): SitesView {
  const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;
  const list = $<HTMLElement>('#sitesList');
  const stats = $<HTMLElement>('#sitesStats');
  const search = $<HTMLInputElement>('#sitesSearch');
  const addLocation = $<HTMLButtonElement>('#sitesAddLocation');
  const addPoint = $<HTMLButtonElement>('#sitesAddPoint');
  const deviceKey = `vto:device-point:${account.id}`;
  const LAYOUT_KEY = 'vto:sites-layout';
  const layoutTabs = $<HTMLElement>('#sitesLayout');
  let layout: Layout = readStored(LAYOUT_KEY) === 'table' ? 'table' : 'cards';

  let sites: Sites = { locations: [], points: [] };
  let counts = new Map<string, number>();
  let devicePoint = readStored(deviceKey);

  const locationOf = (point: Point) => sites.locations.find((location) => location.id === point.locationId);
  const pointsIn = (location: Location) => sites.points.filter((point) => point.locationId === location.id);
  const capturesIn = (points: Point[]) => points.reduce((sum, point) => sum + (counts.get(point.id) ?? 0), 0);

  function setDevicePoint(id: string | null): void {
    devicePoint = id;
    writeStored(deviceKey, id);
    render();
    handlers.onDevicePoint();
  }

  // ---------- dialogs ----------

  function editLocation(location?: Location): void {
    const points = location ? pointsIn(location) : [];
    formDialog({
      title: location ? 'Ubah lokasi' : 'Tambah lokasi',
      description: location ? undefined : 'Toko, mal atau tempat acara. Booth-nya ditambahkan setelah ini.',
      submitLabel: location ? 'Simpan' : 'Tambah lokasi',
      fields: [
        { name: 'name', label: 'Nama', value: location?.name ?? '', placeholder: 'Contoh: Dusun Bambu Lembang' },
        { name: 'city', label: 'Kota', value: location?.city ?? '', placeholder: 'Contoh: Bandung Barat' },
        { name: 'address', label: 'Alamat', value: location?.address ?? '', placeholder: 'Opsional' },
      ],
      danger: location && {
        label: 'Hapus',
        run(close) {
          close();
          confirmDialog({
            title: `Hapus ${location.name}?`,
            message: points.length
              ? `${points.length} booth di dalamnya ikut terhapus. Hasil foto yang sudah tersimpan tetap ada di galeri.`
              : 'Lokasi ini belum punya booth.',
            confirmLabel: 'Hapus lokasi',
            async run() {
              await backend.deleteLocation(location.id);
              await refresh();
            },
          });
        },
      },
      async submit(values) {
        const saved = await backend.saveLocation({
          id: location?.id,
          name: values.name as string,
          city: values.city as string,
          address: values.address as string,
        });
        await refresh();
        // Straight on to the new location's first point, once this dialog has closed.
        if (!location) setTimeout(() => editPoint(undefined, saved.id));
      },
    });
  }

  function editPoint(point?: Point, locationId?: string): void {
    if (sites.locations.length === 0) {
      editLocation();
      return;
    }
    const takenCodes = sites.points.filter((other) => other.id !== point?.id).map((other) => other.code);
    const startLocation = point?.locationId ?? locationId ?? sites.locations[0].id;
    const suggest = (id: string) => suggestPointCode(sites.locations.find((location) => location.id === id)?.name ?? '', takenCodes);

    const dialog = formDialog({
      title: point ? 'Ubah booth' : 'Tambah booth',
      description: point ? undefined : 'Satu kiosk, cermin atau booth yang menjalankan aplikasi ini.',
      submitLabel: point ? 'Simpan' : 'Tambah booth',
      fields: [
        { name: 'name', label: 'Nama', value: point?.name ?? '', placeholder: 'Contoh: Booth Saung' },
        {
          name: 'locationId',
          label: 'Lokasi',
          value: startLocation,
          options: sites.locations.map((location) => ({ value: location.id, label: `${location.name} · ${location.city}` })),
        },
        { name: 'code', label: 'Kode', value: point?.code ?? suggest(startLocation), hint: 'Ditempel di unit agar staf bisa membedakan setiap booth.' },
        { name: 'active', label: 'Aktif', value: point?.active ?? true, hint: 'Booth yang dijeda tetap tercantum tapi tidak bisa dipilih di perangkat.' },
      ],
      danger: point && {
        label: 'Hapus',
        run(close) {
          close();
          confirmDialog({
            title: `Hapus ${point.name}?`,
            message: 'Hasil foto yang sudah tersimpan dari booth ini tetap ada di galeri.',
            confirmLabel: 'Hapus booth',
            async run() {
              await backend.deletePoint(point.id);
              await refresh();
            },
          });
        },
      },
      async submit(values) {
        await backend.savePoint({
          id: point?.id,
          name: values.name as string,
          locationId: values.locationId as string,
          code: values.code as string,
          active: values.active as boolean,
        });
        await refresh();
      },
    });

    // Follow the location with the code suggestion until someone types their own code.
    if (!point) {
      const code = dialog.input('code');
      let suggested = code.value;
      dialog.input('locationId').addEventListener('change', (event) => {
        if (code.value !== suggested) return;
        suggested = suggest((event.target as HTMLSelectElement).value);
        code.value = suggested;
      });
    }
  }

  /** Lists every active point by location; picking one makes it this device's point. */
  function pickDevicePoint(): void {
    const active = sites.points.filter((point) => point.active);
    const body: HTMLElement[] = [];
    for (const location of sites.locations) {
      const points = active.filter((point) => point.locationId === location.id);
      if (points.length === 0) continue;
      const group = el('div', 'pick-group');
      group.append(el('p', 'kicker', `${location.name} · ${location.city}`));
      for (const point of points) {
        const row = el('button', 'pick-row');
        row.type = 'button';
        row.classList.toggle('is-active', point.id === devicePoint);
        const text = el('span', 'pick-text');
        text.append(el('span', 'pick-name', point.name), el('span', 'code', point.code));
        row.append(tile('point'), text);
        if (point.id === devicePoint) row.append(icon('check'));
        row.addEventListener('click', () => {
          setDevicePoint(point.id);
          dialog.close();
        });
        group.append(row);
      }
      body.push(group);
    }
    if (body.length === 0) {
      body.push(el('p', 'card-desc', 'Belum ada booth aktif. Tambahkan lokasi dan booth dulu.'));
    }

    const manage = actionButton('Kelola lokasi', 'btn btn-outline');
    manage.dataset.close = '';
    manage.addEventListener('click', handlers.onOpenSites);
    const footer: HTMLElement[] = [manage];
    if (devicePoint) {
      const clear = actionButton('Lepas', 'btn btn-ghost btn-danger');
      clear.addEventListener('click', () => {
        setDevicePoint(null);
        dialog.close();
      });
      footer.unshift(clear);
    }
    const dialog = openDialog({
      title: 'Perangkat ini booth yang mana?',
      description: 'Foto dan lembar photobooth dari perangkat ini dihitung untuk booth tersebut.',
      body,
      footer,
    });
  }

  // ---------- page ----------

  function renderStats(): void {
    const activePoints = sites.points.filter((point) => point.active).length;
    stats.replaceChildren(
      stat('Lokasi', String(sites.locations.length), 'tempat usaha', 'pin', 'soft'),
      stat('Booth', String(sites.points.length), 'di semua lokasi', 'point', 'soft'),
      stat('Aktif', String(activePoints), `${sites.points.length - activePoints} dijeda`, 'check', 'soft'),
    );
  }

  /** "This device" on the device's own point, a Use here button on other active points. */
  function deviceControl(point: Point): HTMLElement | null {
    if (point.id === devicePoint) return el('span', 'this-device', 'Perangkat ini');
    if (!point.active) return null;
    const use = actionButton('Pakai di sini', 'btn btn-ghost btn-sm');
    use.addEventListener('click', () => setDevicePoint(point.id));
    return use;
  }

  function addPointButton(location: Location): HTMLButtonElement {
    const add = actionButton('Tambah booth', 'btn btn-ghost btn-sm add-point', 'plus');
    add.addEventListener('click', () => editPoint(undefined, location.id));
    return add;
  }

  function editLocationButton(location: Location): HTMLButtonElement {
    const edit = iconButton('edit', `Ubah ${location.name}`);
    edit.addEventListener('click', () => editLocation(location));
    return edit;
  }

  const locationMeta = (location: Location) => [location.city, location.address].filter(Boolean).join(' · ');
  const noPoints = () => (search.value ? 'Tidak ada booth yang cocok.' : 'Belum ada booth.');

  // ---------- card view ----------

  function pointRow(point: Point): HTMLElement {
    const row = el('div', 'point-row');
    const main = el('button', 'point-main');
    main.type = 'button';
    main.title = `Ubah ${point.name}`;
    const text = el('span', 'point-text');
    text.append(el('span', 'point-name', point.name), el('span', 'code', point.code));
    main.append(tile('point'), text, statusBadge(point.active));
    main.addEventListener('click', () => editPoint(point));
    row.classList.toggle('is-paused', !point.active);
    row.append(main);
    const device = deviceControl(point);
    if (device) row.append(device);
    return row;
  }

  function locationCard({ location, points }: Group): HTMLElement {
    const card = el('article', 'site-card');
    const head = el('header', 'site-head');
    const title = el('div', 'site-title');
    title.append(el('h3', 'card-title', location.name), el('p', 'card-desc', locationMeta(location)));
    head.append(tile('pin', 'ink'), title, editLocationButton(location));

    const rows = el('div', 'point-list');
    if (points.length) rows.append(...points.map(pointRow));
    else rows.append(el('p', 'point-empty', noPoints()));
    rows.append(addPointButton(location));

    const all = pointsIn(location);
    const split = el('footer', 'split-stats');
    for (const [label, value] of [
      ['Booth', all.length],
      ['Aktif', all.filter((point) => point.active).length],
      ['Hasil foto', capturesIn(all)],
    ] as const) {
      const cell = el('div', 'split-cell');
      cell.append(el('span', 'split-label', label), el('strong', 'split-value', String(value)));
      split.append(cell);
    }
    card.append(head, rows, split);
    return card;
  }

  // ---------- table view ----------

  // Phones drop the code and captures columns; the code moves under the point name.
  const COLUMNS = [
    ['Booth', ''],
    ['Kode', 'col-wide'],
    ['Status', ''],
    ['Hasil foto', 'num col-wide'],
    ['Aksi', 'actions'],
  ] as const;

  function pointTable(groups: Group[]): HTMLElement {
    const table = el('table', 'data-table');
    const head = table.createTHead().insertRow();
    for (const [label, className] of COLUMNS) {
      const th = el('th', className, label);
      th.scope = 'col';
      head.append(th);
    }

    const body = table.createTBody();
    for (const { location, points } of groups) {
      // Each location heads its own rows, so the table keeps the location → point grouping.
      const groupRow = body.insertRow();
      groupRow.className = 'group-row';
      const cell = el('th');
      cell.scope = 'colgroup';
      cell.colSpan = COLUMNS.length;
      const inner = el('div', 'group-cell');
      const text = el('div', 'group-text');
      const count = pointsIn(location).length;
      text.append(el('span', 'group-name', location.name), el('span', 'card-desc', `${locationMeta(location)} · ${count} booth`));
      inner.append(tile('pin', 'ink'), text, addPointButton(location), editLocationButton(location));
      cell.append(inner);
      groupRow.append(cell);

      if (points.length === 0) {
        const empty = body.insertRow().insertCell();
        empty.colSpan = COLUMNS.length;
        empty.className = 'cell-empty';
        empty.textContent = noPoints();
        continue;
      }
      for (const point of points) {
        const row = body.insertRow();
        row.className = 'point-tr';
        row.classList.toggle('is-paused', !point.active);
        // The whole row opens the point, except the buttons inside it.
        row.addEventListener('click', (event) => {
          if (!(event.target as Element).closest('button')) editPoint(point);
        });
        const name = el('div', 'cell-point');
        const text = el('span', 'point-text');
        text.append(el('span', 'point-name', point.name), el('span', 'code cell-code', point.code));
        name.append(tile('point'), text);
        row.insertCell().append(name);
        const code = row.insertCell();
        code.className = 'col-wide';
        code.append(el('span', 'code', point.code));
        row.insertCell().append(statusBadge(point.active));
        const captures = row.insertCell();
        captures.className = 'num col-wide';
        captures.textContent = String(counts.get(point.id) ?? 0);
        const actions = el('div', 'row-actions');
        const device = deviceControl(point);
        if (device) actions.append(device);
        const edit = iconButton('edit', `Ubah ${point.name}`);
        edit.addEventListener('click', () => editPoint(point));
        actions.append(edit);
        const actionCell = row.insertCell();
        actionCell.className = 'actions';
        actionCell.append(actions);
      }
    }
    const wrap = el('div', 'table-wrap');
    wrap.append(table);
    return wrap;
  }

  function emptyState(title: string, desc: string, action?: HTMLButtonElement): HTMLElement {
    const empty = el('div', 'empty');
    const badge = el('span', 'empty-icon');
    badge.append(icon('pin'));
    empty.append(badge, el('p', 'empty-title', title), el('p', 'empty-desc', desc));
    if (action) empty.append(action);
    return empty;
  }

  function renderList(): void {
    const query = search.value.trim().toLowerCase();
    const matches = (...values: string[]) => values.some((value) => value.toLowerCase().includes(query));

    if (sites.locations.length === 0) {
      const add = actionButton('Tambah lokasi', 'btn btn-outline btn-sm', 'plus');
      add.addEventListener('click', () => editLocation());
      list.replaceChildren(
        emptyState('Tambahkan lokasi pertama', 'Mulai dari toko atau tempat acara, lalu tambahkan kiosk, cermin atau booth di dalamnya.', add),
      );
      return;
    }

    const groups = sites.locations.flatMap((location): Group[] => {
      const points = pointsIn(location);
      if (!query || matches(location.name, location.city, location.address)) return [{ location, points }];
      const hits = points.filter((point) => matches(point.name, point.code));
      return hits.length ? [{ location, points: hits }] : [];
    });
    if (groups.length === 0) {
      list.replaceChildren(emptyState('Tidak ada yang cocok', `Tidak ada lokasi atau booth yang cocok dengan “${search.value.trim()}”.`));
      return;
    }
    list.replaceChildren(...(layout === 'table' ? [pointTable(groups)] : groups.map(locationCard)));
  }

  function renderDeviceCard(): void {
    const point = sites.points.find((candidate) => candidate.id === devicePoint);
    const location = point && locationOf(point);
    $('#deviceName').textContent = point?.name ?? 'Belum ada booth';
    $('#deviceMeta').textContent = point && location ? `${location.name} · ${point.code}` : 'Hasil foto belum terhubung ke booth.';
    $('#deviceChange').textContent = point ? 'Ganti' : 'Pilih booth';
  }

  function render(): void {
    renderStats();
    renderList();
    renderDeviceCard();
  }

  async function refresh(): Promise<void> {
    [sites, counts] = await Promise.all([backend.sites(), handlers.captureCounts()]);
    // A deleted or paused point stops being this device's point.
    if (devicePoint && !sites.points.some((point) => point.id === devicePoint && point.active)) {
      devicePoint = null;
      writeStored(deviceKey, null);
    }
    render();
    handlers.onSites?.(sites);
  }

  addLocation.addEventListener('click', () => editLocation());
  addPoint.addEventListener('click', () => editPoint());
  $('#deviceChange').addEventListener('click', pickDevicePoint);
  search.addEventListener('input', renderList);

  function markLayout(): void {
    list.classList.toggle('is-table', layout === 'table');
    for (const button of layoutTabs.querySelectorAll<HTMLElement>('button')) {
      button.classList.toggle('is-active', button.dataset.layout === layout);
    }
  }
  segmented(layoutTabs, (button) => {
    layout = button.dataset.layout as Layout;
    writeStored(LAYOUT_KEY, layout);
    markLayout();
    renderList();
  });
  markLayout();

  return {
    refresh,
    devicePointId: () => devicePoint,
    pickDevicePoint,
    pointLabel(id) {
      const point = sites.points.find((candidate) => candidate.id === id);
      const location = point && locationOf(point);
      return point ? [point.name, location?.name].filter(Boolean).join(' · ') : null;
    },
  };
}
