// Settings: booth categories and their prices, print prices, merchandise, discount presets, booth
// profiles, shifts, retention, payments, ads and events.

import { formDialog } from '../../../dialogs';
import { iconButton } from '../../../icons';
import { putBlob, deleteBlob } from '../../blobs';
import { SESSION_MODES, type SessionMode } from '../../model';
import { PAPER, PAPER_SIZES } from '../../printing';
import { isTimeZone } from '../../time';
import type { PageContext } from '../router';
import { act, badge, el, fileInput, money, notice, page, parseAmount, section, table } from '../kit';

const MODES = Object.keys(SESSION_MODES) as SessionMode[];

export function renderSettings({ ops }: PageContext): HTMLElement {
  const { state } = ops;
  const view = page('Settings', 'Prices and rules every booth and till in this workspace follows.');

  // ---------- booth categories ----------
  const categories = section('Booth categories', 'A kind of booth with its own price per session mode. Each booth belongs to one.');
  const editCategory = (id?: string) => {
    const category = state.categories.find((entry) => entry.id === id);
    formDialog({
      title: category ? `Edit ${category.name}` : 'Add booth category',
      submitLabel: 'Save',
      fields: [
        { name: 'name', label: 'Name', value: category?.name ?? '', placeholder: 'Photobox' },
        ...MODES.map((mode) => ({ name: mode, label: `${SESSION_MODES[mode].label} price`, value: String(category?.prices[mode] ?? ''), type: 'number' as const, hint: 'Leave empty to stop selling this mode.' })),
      ],
      danger: category && state.categories.length > 1 ? { label: 'Delete', run: (close) => { ops.edit('settings.manage', 'category.delete', `Deleted booth category ${category.name}.`, (draft) => { draft.categories = draft.categories.filter((entry) => entry.id !== id); }); close(); } } : undefined,
      async submit(values) {
        const name = String(values.name).trim();
        if (!name) throw new Error('Enter a name.');
        const prices = Object.fromEntries(MODES.filter((mode) => String(values[mode]).trim()).map((mode) => [mode, parseAmount(String(values[mode]))]));
        ops.edit('settings.manage', 'category.save', `Saved booth category ${name}.`, (draft) => {
          const existing = draft.categories.find((entry) => entry.id === id);
          if (existing) Object.assign(existing, { name, prices });
          else draft.categories.push({ id: ops.store.id(), name, prices });
        });
      },
    });
  };
  categories.actions.append(act('Add category', 'btn btn-outline btn-sm', () => editCategory(), 'plus'));
  categories.body.append(
    table(
      [
        { label: 'Category', cell: (row) => row.name },
        ...MODES.map((mode) => ({ label: SESSION_MODES[mode].label, className: 'num', cell: (row: (typeof state.categories)[number]) => (row.prices[mode] === undefined ? '—' : money(row.prices[mode]!)) })),
      ],
      state.categories,
      { onRow: (row) => editCategory(row.id) },
    ),
  );

  // ---------- booth profiles ----------
  const booths = section('Booths', 'Category, time zone and session modes per booth. Vouchers and reports follow each booth’s own clock.');
  booths.body.append(
    table(
      [
        { label: 'Booth', cell: (point) => `${point.name} · ${ops.branchName(point.locationId)}` },
        { label: 'Category', cell: (point) => state.categories.find((entry) => entry.id === ops.profile(point.id).categoryId)?.name ?? '—' },
        { label: 'Time zone', cell: (point) => ops.profile(point.id).timeZone },
        { label: 'Modes', cell: (point) => ops.profile(point.id).modes.map((mode) => SESSION_MODES[mode].label).join(', ') },
      ],
      ops.visibleBooths(),
      {
        empty: 'Add booths on the Locations page first.',
        onRow: (point) => {
          const profile = ops.profile(point.id);
          formDialog({
            title: point.name,
            submitLabel: 'Save',
            fields: [
              { name: 'categoryId', label: 'Category', value: profile.categoryId, options: state.categories.map((entry) => ({ value: entry.id, label: entry.name })) },
              { name: 'timeZone', label: 'Time zone', value: profile.timeZone, hint: 'An IANA name, such as Asia/Jakarta, Asia/Makassar or Asia/Singapore.' },
              { name: 'modes', label: 'Session modes', value: profile.modes, options: MODES.map((mode) => ({ value: mode, label: SESSION_MODES[mode].label })) },
            ],
            async submit(values) {
              const timeZone = String(values.timeZone).trim();
              if (!isTimeZone(timeZone)) throw new Error(`${timeZone} is not a time zone.`);
              const modes = values.modes as SessionMode[];
              if (modes.length === 0) throw new Error('Pick at least one mode.');
              ops.saveProfile({ pointId: point.id, categoryId: String(values.categoryId), timeZone, modes });
            },
          });
        },
      },
    ),
  );

  // ---------- print prices ----------
  const prints = section('Print prices', 'What an extra print costs at the booth and at the till.');
  const editPrint = (size?: string) => {
    const existing = state.printPrices.find((entry) => entry.size === size);
    formDialog({
      title: existing ? `Edit ${existing.size}` : 'Add print size',
      submitLabel: 'Save',
      fields: [
        { name: 'size', label: 'Size', value: existing?.size ?? '4R', options: PAPER_SIZES.map((paper) => ({ value: paper, label: PAPER[paper].label })) },
        { name: 'price', label: 'Price', value: String(existing?.price ?? ''), type: 'number' },
      ],
      danger: existing ? { label: 'Delete', run: (close) => { ops.edit('settings.manage', 'print.delete', `Stopped selling ${existing.size} prints.`, (draft) => { draft.printPrices = draft.printPrices.filter((entry) => entry.size !== size); }); close(); } } : undefined,
      async submit(values) {
        const price = parseAmount(String(values.price));
        if (price <= 0) throw new Error('Enter a price.');
        ops.edit('settings.manage', 'print.save', `${values.size} prints cost ${money(price)}.`, (draft) => {
          draft.printPrices = [...draft.printPrices.filter((entry) => entry.size !== values.size && entry.size !== size), { size: values.size as never, price }];
        });
      },
    });
  };
  prints.actions.append(act('Add size', 'btn btn-outline btn-sm', () => editPrint(), 'plus'));
  prints.body.append(table([{ label: 'Size', cell: (row) => PAPER[row.size].label }, { label: 'Price', className: 'num', cell: (row) => money(row.price) }], state.printPrices, { onRow: (row) => editPrint(row.size) }));

  // ---------- merchandise ----------
  const products = section('Merchandise', 'Sold at the till. Stock goes down with each sale and back up on a refund.');
  const editProduct = (id?: string) => {
    const product = state.products.find((entry) => entry.id === id);
    formDialog({
      title: product ? `Edit ${product.name}` : 'Add product',
      submitLabel: 'Save',
      fields: [
        { name: 'name', label: 'Name', value: product?.name ?? '', placeholder: 'Keychain frame' },
        { name: 'sku', label: 'SKU', value: product?.sku ?? '' },
        { name: 'price', label: 'Price', value: String(product?.price ?? ''), type: 'number' },
        { name: 'stock', label: 'In stock', value: String(product?.stock ?? 0), type: 'number' },
      ],
      danger: product ? { label: 'Delete', run: (close) => { ops.edit('settings.manage', 'product.delete', `Deleted ${product.name}.`, (draft) => { draft.products = draft.products.filter((entry) => entry.id !== id); }); close(); } } : undefined,
      async submit(values) {
        const name = String(values.name).trim();
        const price = parseAmount(String(values.price));
        const stock = parseAmount(String(values.stock));
        if (!name || price <= 0) throw new Error('Enter a name and a price.');
        if (stock < 0) throw new Error('Stock cannot be negative.');
        ops.edit('settings.manage', 'product.save', `${product ? 'Updated' : 'Added'} ${name}, ${stock} in stock.`, (draft) => {
          const existing = draft.products.find((entry) => entry.id === id);
          const fields = { name, sku: String(values.sku).trim(), price, stock };
          if (existing) Object.assign(existing, fields);
          else draft.products.push({ id: ops.store.id(), ...fields });
        });
      },
    });
  };
  products.actions.append(act('Add product', 'btn btn-outline btn-sm', () => editProduct(), 'plus'));
  products.body.append(
    table(
      [
        { label: 'Product', cell: (row) => row.name },
        { label: 'SKU', cell: (row) => row.sku || '—' },
        { label: 'Price', className: 'num', cell: (row) => money(row.price) },
        { label: 'Stock', className: 'num', cell: (row) => (row.stock === 0 ? badge('Sold out', 'error') : String(row.stock)) },
      ],
      state.products,
      { empty: 'No merchandise yet.', onRow: (row) => editProduct(row.id) },
    ),
  );

  // ---------- discount presets ----------
  const presets = section('Discount presets', 'One-tap discounts at the till, such as a staff or bundle price. Needs the discount permission.');
  const editPreset = (id?: string) => {
    const preset = state.presets.find((entry) => entry.id === id);
    formDialog({
      title: preset ? `Edit ${preset.name}` : 'Add discount preset',
      submitLabel: 'Save',
      fields: [
        { name: 'name', label: 'Name', value: preset?.name ?? '', placeholder: 'Student 10%' },
        { name: 'kind', label: 'Type', value: preset?.kind ?? 'percent', options: [{ value: 'percent', label: 'Percent off' }, { value: 'amount', label: 'Rupiah off' }] },
        { name: 'value', label: 'Value', value: String(preset?.value ?? ''), type: 'number' },
      ],
      danger: preset ? { label: 'Delete', run: (close) => { ops.edit('settings.manage', 'preset.delete', `Deleted preset ${preset.name}.`, (draft) => { draft.presets = draft.presets.filter((entry) => entry.id !== id); }); close(); } } : undefined,
      async submit(values) {
        const name = String(values.name).trim();
        const value = parseAmount(String(values.value));
        if (!name || value <= 0) throw new Error('Enter a name and a value.');
        if (values.kind === 'percent' && value > 100) throw new Error('A percentage goes up to 100.');
        ops.edit('settings.manage', 'preset.save', `Saved preset ${name}.`, (draft) => {
          const existing = draft.presets.find((entry) => entry.id === id);
          const fields = { name, kind: values.kind as 'percent' | 'amount', value };
          if (existing) Object.assign(existing, fields);
          else draft.presets.push({ id: ops.store.id(), ...fields });
        });
      },
    });
  };
  presets.actions.append(act('Add preset', 'btn btn-outline btn-sm', () => editPreset(), 'plus'));
  presets.body.append(table([{ label: 'Preset', cell: (row) => row.name }, { label: 'Discount', className: 'num', cell: (row) => (row.kind === 'percent' ? `${row.value}%` : money(row.value)) }], state.presets, { empty: 'No presets yet.', onRow: (row) => editPreset(row.id) }));

  // ---------- operations ----------
  const rules = section('Operations', 'Shifts, retention, payments and the queue.');
  const s = state.settings;
  rules.actions.append(
    act('Edit', 'btn btn-outline btn-sm', () =>
      formDialog({
        title: 'Operations',
        submitLabel: 'Save',
        fields: [
          { name: 'shiftsEnabled', label: 'Require an open shift to sell', value: s.shiftsEnabled, hint: 'Turn off for a booth with no cashier.' },
          { name: 'retentionDays', label: 'Keep customer photos for (days)', value: String(s.retentionDays), type: 'number', hint: '0 keeps them forever. Older files are deleted every day; the sales record stays.' },
          { name: 'gateway', label: 'QRIS gateway', value: s.gateway, options: [{ value: 'midtrans', label: 'Midtrans' }, { value: 'xendit', label: 'Xendit' }, { value: 'doku', label: 'DOKU' }], hint: 'This build simulates the gateway. The server integration uses your merchant keys.' },
          { name: 'queuePrefix', label: 'Queue number prefix', value: s.queuePrefix },
          {
            name: 'faceLibrary',
            label: 'Face list on the AI presets page',
            value: s.faceLibrary,
            options: [{ value: 'all', label: 'Every face captured, until retention deletes it' }, { value: 'visit', label: 'Only the current customer’s faces' }],
            hint: 'Every face lets regulars reuse theirs, but every customer can see them. Pick the second for public booths.',
          },
          { name: 'receiptFooter', label: 'Receipt footer', value: s.receiptFooter, type: 'textarea' },
        ],
        async submit(values) {
          const retentionDays = parseAmount(String(values.retentionDays));
          if (retentionDays < 0) throw new Error('Retention cannot be negative.');
          ops.edit('settings.manage', 'settings.save', 'Updated operations settings.', (draft) => {
            Object.assign(draft.settings, {
              shiftsEnabled: values.shiftsEnabled as boolean,
              retentionDays,
              gateway: values.gateway as never,
              queuePrefix: String(values.queuePrefix).trim().toUpperCase().slice(0, 3) || 'A',
              faceLibrary: values.faceLibrary as 'all' | 'visit',
              receiptFooter: String(values.receiptFooter).trim(),
            });
          });
        },
      }),
    'edit'),
    act('Purge now', 'btn btn-ghost btn-sm', async () => notice(`Purged ${await ops.purgeExpired()} sessions.`, 'ok')),
  );
  const facts = el('dl', 'facts');
  for (const [label, value] of [
    ['Shifts', s.shiftsEnabled ? 'Required to sell' : 'Off'],
    ['Photo retention', s.retentionDays ? `${s.retentionDays} days, then deleted` : 'Kept forever'],
    ['QRIS gateway', `${{ midtrans: 'Midtrans', xendit: 'Xendit', doku: 'DOKU' }[s.gateway]} (simulated)`],
    ['Queue numbers', `${s.queuePrefix}001, ${s.queuePrefix}002 …`],
    ['Face list', s.faceLibrary === 'all' ? `Every face captured (${state.faces.length} kept)` : 'Current customer only'],
  ]) {
    facts.append(el('dt', '', label), el('dd', '', value));
  }
  rules.body.append(facts);

  // ---------- idle-screen ads ----------
  const ads = section('Idle-screen ads', 'Played full screen on a booth that waits with no customer. A tap goes back to the start screen.');
  const upload = fileInput('image/*,video/*', async (file) => {
    const src = await putBlob(file);
    ops.edit('branding.manage', 'ad.add', `Added ad ${file.name}.`, (draft) => {
      draft.ads.push({ id: ops.store.id(), name: file.name, kind: file.type.startsWith('video/') ? 'video' : 'image', src, seconds: 8, active: true });
    });
  });
  ads.actions.append(
    upload,
    act('Upload ad', 'btn btn-outline btn-sm', () => upload.click(), 'upload'),
    act(s.adsEnabled ? 'Turn off' : 'Turn on', 'btn btn-ghost btn-sm', () =>
      ops.edit('branding.manage', 'ads.toggle', `${s.adsEnabled ? 'Stopped' : 'Started'} the idle-screen ads.`, (draft) => { draft.settings.adsEnabled = !draft.settings.adsEnabled; }),
    ),
    act(`Idle ${s.idleSeconds}s`, 'btn btn-ghost btn-sm', () =>
      formDialog({
        title: 'Idle time',
        submitLabel: 'Save',
        fields: [{ name: 'seconds', label: 'Seconds without a touch before ads play', value: String(s.idleSeconds), type: 'number' }],
        async submit(values) {
          const seconds = parseAmount(String(values.seconds));
          if (seconds < 10) throw new Error('Use at least 10 seconds.');
          ops.edit('branding.manage', 'ads.idle', `Ads start after ${seconds} idle seconds.`, (draft) => { draft.settings.idleSeconds = seconds; });
        },
      }),
    ),
  );
  ads.body.append(
    table(
      [
        { label: 'Ad', cell: (row) => row.name },
        { label: 'Type', cell: (row) => (row.kind === 'video' ? 'Video' : 'Image') },
        { label: 'Seconds', className: 'num', cell: (row) => (row.kind === 'video' ? 'Full clip' : String(row.seconds)) },
        { label: 'Status', cell: (row) => badge(row.active ? 'Playing' : 'Paused', row.active ? 'ok' : 'muted') },
        {
          label: '',
          className: 'actions',
          cell: (row) => {
            const remove = iconButton('trash', `Delete ${row.name}`);
            remove.addEventListener('click', async () => {
              await deleteBlob(row.src);
              ops.edit('branding.manage', 'ad.delete', `Deleted ad ${row.name}.`, (draft) => { draft.ads = draft.ads.filter((entry) => entry.id !== row.id); });
            });
            return remove;
          },
        },
      ],
      state.ads,
      {
        empty: s.adsEnabled ? 'Upload an image or a short video.' : 'Ads are off. Upload some, then turn them on.',
        onRow: (row) => ops.edit('branding.manage', 'ad.toggle', `${row.active ? 'Paused' : 'Resumed'} ad ${row.name}.`, (draft) => { const ad = draft.ads.find((entry) => entry.id === row.id)!; ad.active = !ad.active; }),
      },
    ),
  );

  // ---------- events ----------
  const events = section('Events', 'Group the sessions of an event under one gallery link, such as a wedding or a brand activation.');
  const editEvent = (id?: string) => {
    const event = state.events.find((entry) => entry.id === id);
    formDialog({
      title: event ? `Edit ${event.name}` : 'Add event',
      submitLabel: 'Save',
      fields: [
        { name: 'name', label: 'Name', value: event?.name ?? '', placeholder: 'Rani & Dimas wedding' },
        { name: 'from', label: 'From', value: event?.from ?? '', type: 'date' },
        { name: 'to', label: 'To', value: event?.to ?? '', type: 'date' },
        { name: 'boothIds', label: 'Booths', value: event?.boothIds ?? [], options: ops.visibleBooths().map((point) => ({ value: point.id, label: point.name })), hint: 'None ticked means every booth.' },
      ],
      danger: event ? { label: 'Delete', run: (close) => { ops.edit('settings.manage', 'event.delete', `Deleted event ${event.name}.`, (draft) => { draft.events = draft.events.filter((entry) => entry.id !== id); }); close(); } } : undefined,
      async submit(values) {
        const name = String(values.name).trim();
        if (!name) throw new Error('Enter a name.');
        if (values.from && values.to && String(values.to) < String(values.from)) throw new Error('The event ends before it starts.');
        ops.edit('settings.manage', 'event.save', `Saved event ${name}.`, (draft) => {
          const fields = { name, from: String(values.from), to: String(values.to), boothIds: values.boothIds as string[] };
          const existing = draft.events.find((entry) => entry.id === id);
          if (existing) Object.assign(existing, fields);
          else draft.events.push({ id: ops.store.id(), ...fields });
        });
      },
    });
  };
  events.actions.append(act('Add event', 'btn btn-outline btn-sm', () => editEvent(), 'plus'));
  events.body.append(
    table(
      [
        { label: 'Event', cell: (row) => row.name },
        { label: 'Dates', cell: (row) => [row.from, row.to].filter(Boolean).join(' – ') || 'Open' },
        { label: 'Sessions', className: 'num', cell: (row) => String(state.sessions.filter((session) => session.eventId === row.id).length) },
        {
          label: 'Gallery link',
          cell: (row) => {
            const link = el('a', 'link', 'Open');
            link.href = ops.eventLink(row.id);
            link.target = '_blank';
            return link;
          },
        },
      ],
      state.events,
      { empty: 'No events yet.', onRow: (row) => editEvent(row.id) },
    ),
  );

  view.body.append(categories.root, booths.root, prints.root, products.root, presets.root, rules.root, ads.root, events.root);
  return view.root;
}
