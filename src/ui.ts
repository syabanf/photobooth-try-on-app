import { CATEGORY_LABELS, loadImage, type CatalogItem, type Category } from './catalog';
import { openDialog } from './dialogs';
import { hydrateIcons, icon, type IconName } from './icons';

export type Mode = 'local' | 'ai';
export type OpsView = 'setup' | 'faces' | 'roles' | 'signins' | 'history' | 'pos' | 'queue' | 'sales' | 'payments' | 'reports' | 'vouchers' | 'frames' | 'branding' | 'devices' | 'staff' | 'fleet' | 'settings';
export type View = 'dashboard' | 'tryon' | 'photobooth' | 'gallery' | 'sites' | 'session' | 'presets' | 'gate' | OpsView;

/** Views that show the camera stage. */
export const CAMERA_VIEWS: readonly View[] = ['tryon', 'photobooth', 'session', 'presets', 'gate'];

/** Business pages, drawn by src/ops/ui into one container. */
export const OPS_VIEWS: readonly OpsView[] = ['setup', 'faces', 'roles', 'signins', 'history', 'pos', 'queue', 'sales', 'payments', 'reports', 'vouchers', 'frames', 'branding', 'devices', 'staff', 'fleet', 'settings'];
export const isOpsView = (view: View): view is OpsView => (OPS_VIEWS as readonly string[]).includes(view);
export type StatusKind = 'info' | 'warn' | 'error' | 'ok';

export interface UiHandlers {
  onCategory(category: Category): void;
  onSelect(item: CatalogItem): void;
  onUpload(file: File): void;
  onSize(factor: number): void;
  onMode(mode: Mode): void;
  onConnectAi(apiKey: string): void;
  onHandControl(): void;
  onView(view: View): void;
  /** The round accent button in the rail and the bottom bar. */
  onCapture(): void;
  onSnapshot(): void;
  onRetry(): void;
}

export interface UiApi {
  /** Hides menu entries for pages the current person may not open. */
  setAllowed(check: (view: View) => boolean): void;
  setStatus(text: string, kind?: StatusKind, retry?: boolean): void;
  setTabs(active: Category, worn: readonly Category[]): void;
  renderStrip(items: CatalogItem[], selectedId: string | null): void;
  setSnapshotEnabled(enabled: boolean): void;
  setSize(factor: number): void;
  setMode(mode: Mode): void;
  setAiKey(apiKey: string): void;
  setView(view: View): void;
  setGalleryCount(count: number): void;
  setHandControl(on: boolean): void;
}

/** Wires a row of pill buttons so exactly one carries `is-active`, and reports the pick. */
export function segmented(container: HTMLElement, onPick: (button: HTMLButtonElement) => void): void {
  container.addEventListener('click', (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button');
    if (!button || !container.contains(button)) return;
    for (const other of container.querySelectorAll('button')) other.classList.toggle('is-active', other === button);
    onPick(button);
  });
}

const CATEGORIES = Object.keys(CATEGORY_LABELS) as Category[];

const VIEWS: Record<View, { kicker: string; title: string; capture: string }> = {
  dashboard: { kicker: 'Ringkasan', title: 'Beranda', capture: 'Buka kamera' },
  tryon: { kicker: 'Coba pakai virtual', title: 'Coba pakai', capture: 'Ambil foto' },
  photobooth: { kicker: 'Foto dengan timer', title: 'Photobooth', capture: 'Mulai photobooth' },
  gallery: { kicker: 'Tersimpan di perangkat ini', title: 'Galeri', capture: 'Buka kamera' },
  sites: { kicker: 'Tempat usaha berjalan', title: 'Lokasi dan booth', capture: 'Buka kamera' },
  session: { kicker: 'Sesi pelanggan', title: 'Booth', capture: 'Buka kamera' },
  presets: { kicker: 'Wajah pelanggan di setiap template', title: 'Preset AI', capture: 'Buka kamera' },
  gate: { kicker: 'Pindai tiket, foto rombongan', title: 'Gerbang', capture: 'Buka kamera' },
  faces: { kicker: 'Siapa saja yang datang', title: 'Wajah', capture: 'Buka kamera' },
  pos: { kicker: 'Penjualan', title: 'Kasir', capture: 'Buka kamera' },
  queue: { kicker: 'Pelanggan menunggu', title: 'Antrean', capture: 'Buka kamera' },
  sales: { kicker: 'Setiap rupiah', title: 'Transaksi', capture: 'Buka kamera' },
  payments: { kicker: 'Metode, biaya dan gateway', title: 'Pembayaran', capture: 'Buka kamera' },
  reports: { kicker: 'Penjualan, produk, pembayaran, kas dan lantai', title: 'Laporan', capture: 'Buka kamera' },
  vouchers: { kicker: 'Kode dan acara', title: 'Voucher', capture: 'Buka kamera' },
  frames: { kicker: 'Template cetak', title: 'Bingkai', capture: 'Buka kamera' },
  branding: { kicker: 'Layar booth dan galeri', title: 'Merek', capture: 'Buka kamera' },
  devices: { kicker: 'Kamera, printer dan peringatan', title: 'Perangkat', capture: 'Buka kamera' },
  staff: { kicker: 'Akses · siapa yang bisa masuk', title: 'Pengguna', capture: 'Buka kamera' },
  roles: { kicker: 'Akses · apa yang boleh tiap peran', title: 'Peran', capture: 'Buka kamera' },
  signins: { kicker: 'Akses · siapa yang masuk dan kapan', title: 'Log masuk', capture: 'Buka kamera' },
  history: { kicker: 'Semua perubahan', title: 'Riwayat aktivitas', capture: 'Buka kamera' },
  fleet: { kicker: 'Pembaruan, bantuan dan sinkron', title: 'Pembaruan dan bantuan', capture: 'Buka kamera' },
  settings: { kicker: 'Harga dan aturan main', title: 'Harga dan aturan', capture: 'Buka kamera' },
  setup: { kicker: 'Sebelum pelanggan datang', title: 'Panduan setup', capture: 'Buka kamera' },
};

/** Every page in the More sheet, grouped, with the icon its row shows. */
const MENU: { group: string; items: [View, string, IconName][] }[] = [
  // Ordered the way a venue works: serve customers, run the studio, count the money, set things up.
  { group: 'Layani pelanggan', items: [['session', 'Booth', 'booth'], ['presets', 'Preset AI', 'sparkles'], ['gate', 'Gerbang', 'qr'], ['queue', 'Antrean', 'queue'], ['pos', 'Kasir', 'cart']] },
  { group: 'Studio', items: [['tryon', 'Coba pakai', 'shirt'], ['photobooth', 'Photobooth', 'aperture'], ['gallery', 'Galeri', 'images'], ['faces', 'Wajah', 'users']] },
  { group: 'Penjualan dan laporan', items: [['reports', 'Laporan', 'chart'], ['sales', 'Transaksi', 'receipt'], ['history', 'Riwayat aktivitas', 'clock'], ['vouchers', 'Voucher', 'ticket']] },
  { group: 'Pengaturan', items: [['setup', 'Panduan setup', 'check'], ['sites', 'Lokasi dan booth', 'pin'], ['devices', 'Kamera, printer dan peringatan', 'printer'], ['payments', 'Pembayaran', 'wallet'], ['settings', 'Harga dan aturan', 'settings'], ['frames', 'Bingkai', 'frame'], ['branding', 'Merek', 'palette']] },
  { group: 'Tim dan akses', items: [['staff', 'Pengguna', 'users'], ['roles', 'Peran dan izin', 'shield'], ['signins', 'Log masuk', 'key']] },
  { group: 'Sistem', items: [['fleet', 'Pembaruan dan bantuan', 'rocket']] },
];

/** Items shown before "Show all", so the grid stays short on a phone. */
const STRIP_PAGE = 6;
const TILE_SIZE = 160;

const tilePictures = new Map<string, Promise<string>>();

/** A small copy of the prepared item, so a product photo loses its backdrop on the tile too. */
function tilePicture(src: string): Promise<string> {
  let pending = tilePictures.get(src);
  if (!pending) {
    pending = loadImage(src).then(({ source, width, height }) => {
      const scale = TILE_SIZE / Math.max(width, height);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      canvas.getContext('2d')!.drawImage(source, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL();
    });
    tilePictures.set(src, pending);
  }
  return pending;
}
const RAIL_KEY = 'rail-expanded';
const RAIL_GROUPS_KEY = 'rail-closed-groups';

/**
 * The rail: Dashboard, then each menu group under its heading. Expanded, a heading folds its
 * group away; collapsed to icons, headings become thin dividers and every page stays one tap away.
 */
function buildRail(nav: HTMLElement): void {
  const closed = new Set<string>(JSON.parse(readStored(RAIL_GROUPS_KEY) ?? '[]'));
  const item = (view: View, label: string, iconName: IconName) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'rail-item';
    button.dataset.view = view;
    button.title = label;
    const text = document.createElement('span');
    text.className = 'rail-label';
    text.textContent = label;
    button.append(icon(iconName), text);
    if (view === 'gallery') {
      const badge = document.createElement('span');
      badge.className = 'rail-badge';
      badge.dataset.galleryCount = '';
      badge.hidden = true;
      button.append(badge);
    }
    return button;
  };
  nav.append(item('dashboard', 'Beranda', 'dashboard'));
  for (const { group, items } of MENU) {
    const section = document.createElement('div');
    section.className = 'rail-group';
    section.classList.toggle('is-closed', closed.has(group));
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'rail-group-head';
    head.setAttribute('aria-expanded', String(!closed.has(group)));
    const name = document.createElement('span');
    name.textContent = group;
    head.append(name, icon('chevron'));
    head.addEventListener('click', () => {
      const close = !section.classList.contains('is-closed');
      section.classList.toggle('is-closed', close);
      head.setAttribute('aria-expanded', String(!close));
      if (close) closed.add(group);
      else closed.delete(group);
      writeStored(RAIL_GROUPS_KEY, JSON.stringify([...closed]));
    });
    const list = document.createElement('div');
    list.className = 'rail-group-items';
    list.append(...items.map(([view, label, iconName]) => item(view, label, iconName)));
    section.append(head, list);
    nav.append(section);
  }
}

/** A per-device preference. Storage can be refused, and then the setting is forgotten on reload. */
export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Kept in memory for this visit only.
  }
}

export function mountUi(root: HTMLElement, handlers: UiHandlers): UiApi {
  hydrateIcons(root);
  const $ = <T extends Element>(selector: string) => root.querySelector<T>(selector)!;

  const status = $<HTMLElement>('#status');
  const retry = $<HTMLButtonElement>('#retry');
  const tabs = $<HTMLElement>('#tabs');
  const strip = $<HTMLElement>('#strip');
  const stripMore = $<HTMLButtonElement>('#stripMore');
  const upload = $<HTMLInputElement>('#upload');
  const snap = $<HTMLButtonElement>('#snap');
  const modeLocal = $<HTMLButtonElement>('#modeLocal');
  const modeAi = $<HTMLButtonElement>('#modeAi');
  const aiPanel = $<HTMLElement>('#aiPanel');
  const apiKey = $<HTMLInputElement>('#apiKey');
  const size = $<HTMLInputElement>('#size');
  const sizeValue = $<HTMLOutputElement>('#sizeValue');
  const rail = $<HTMLElement>('#rail');
  const railToggle = $<HTMLButtonElement>('#railToggle');
  const captureButtons = [$<HTMLButtonElement>('#railCapture'), $<HTMLButtonElement>('#barCapture')];
  buildRail($<HTMLElement>('#railNav'));
  const navButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-view]')];
  const countBadges = [...root.querySelectorAll<HTMLElement>('[data-gallery-count]')];

  for (const category of CATEGORIES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pill-tab';
    button.dataset.category = category;
    button.textContent = CATEGORY_LABELS[category];
    button.addEventListener('click', () => handlers.onCategory(category));
    tabs.append(button);
  }

  let stripItems: CatalogItem[] = [];
  let stripSelected: string | null = null;
  let stripCategory: Category | null = null;
  let showAll = false;

  function drawStrip(): void {
    const selectedIndex = stripItems.findIndex((item) => item.id === stripSelected);
    const expanded = showAll || selectedIndex >= STRIP_PAGE;
    const visible = expanded ? stripItems : stripItems.slice(0, STRIP_PAGE);
    strip.replaceChildren(
      ...visible.map((item) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'item';
        button.classList.toggle('is-selected', item.id === stripSelected);
        button.title = item.credit ? `${item.name}. ${item.credit}` : item.name;
        const img = document.createElement('img');
        // Same CORS mode as loadImage, so both share one download.
        img.crossOrigin = 'anonymous';
        img.src = item.src;
        img.alt = '';
        // A photo that cannot be read keeps its original picture.
        tilePicture(item.src).then((url) => (img.src = url), () => {});
        const label = document.createElement('span');
        label.className = 'item-name';
        label.textContent = item.name;
        button.append(img, label);
        button.addEventListener('click', () => handlers.onSelect(item));
        return button;
      }),
    );
    stripMore.hidden = stripItems.length <= STRIP_PAGE;
    stripMore.textContent = expanded ? 'Tampilkan lebih sedikit' : `Tampilkan semua ${stripItems.length}`;
  }

  stripMore.addEventListener('click', () => {
    showAll = !showAll;
    drawStrip();
  });

  upload.addEventListener('change', () => {
    const file = upload.files?.[0];
    if (file) handlers.onUpload(file);
    upload.value = '';
  });
  snap.addEventListener('click', handlers.onSnapshot);
  retry.addEventListener('click', handlers.onRetry);
  modeLocal.addEventListener('click', () => handlers.onMode('local'));
  modeAi.addEventListener('click', () => handlers.onMode('ai'));
  $<HTMLButtonElement>('#aiConnect').addEventListener('click', () => handlers.onConnectAi(apiKey.value.trim()));
  const handToggle = $<HTMLButtonElement>('#handToggle');
  handToggle.addEventListener('click', handlers.onHandControl);
  size.addEventListener('input', () => {
    sizeValue.textContent = `${size.value}%`;
    handlers.onSize(Number(size.value) / 100);
  });
  for (const button of captureButtons) button.addEventListener('click', handlers.onCapture);
  for (const button of navButtons) {
    button.addEventListener('click', () => handlers.onView(button.dataset.view as View));
  }

  // The rail and the phone bar hold the busiest pages; More opens a sheet with the rest, leaving out
  // whatever the visible bar already shows.
  const moreButtons = [$<HTMLButtonElement>('#barMore')];
  /** Pages the person on this device may open; the menus hide the rest. */
  let allowed: (view: View) => boolean = () => true;
  const openMore = () => {
    const onBar = new Set(navButtons.filter((button) => button.offsetParent !== null).map((button) => button.dataset.view));
    const body = MENU.flatMap(({ group, items }) => {
      const rows = items
        .filter(([view]) => !onBar.has(view) && allowed(view))
        .map(([view, label, iconName]) => {
          const row = document.createElement('button');
          row.type = 'button';
          row.className = 'pick-row';
          row.dataset.close = '';
          row.dataset.page = view;
          const tile = document.createElement('span');
          tile.className = 'tile tile--soft';
          tile.append(icon(iconName));
          const name = document.createElement('span');
          name.className = 'pick-name pick-text';
          name.textContent = label;
          row.append(tile, name, icon('chevron'));
          row.addEventListener('click', () => handlers.onView(view));
          return row;
        });
      if (rows.length === 0) return [];
      const section = document.createElement('div');
      section.className = 'pick-group';
      const heading = document.createElement('p');
      heading.className = 'kicker';
      heading.textContent = group;
      section.append(heading, ...rows);
      return [section];
    });
    // data-close on each row shuts the sheet after the view switches.
    openDialog({ title: 'Lainnya', body, footer: [] });
  };
  for (const button of moreButtons) button.addEventListener('click', openMore);
  const onMore = (view: View) => !navButtons.some((button) => button.dataset.view === view && button.getClientRects().length > 0);

  const setRailExpanded = (expanded: boolean) => {
    rail.classList.toggle('is-expanded', expanded);
    railToggle.setAttribute('aria-label', expanded ? 'Ciutkan menu' : 'Bentangkan menu');
    writeStored(RAIL_KEY, expanded ? '1' : '0');
  };
  // Expanded until someone collapses it: with every page in the rail, labels and headings matter.
  setRailExpanded(readStored(RAIL_KEY) !== '0');
  railToggle.addEventListener('click', () => setRailExpanded(!rail.classList.contains('is-expanded')));

  return {
    setAllowed(check) {
      allowed = check;
      for (const button of navButtons) button.hidden = !check(button.dataset.view as View);
      // A group with nothing this person may open leaves the rail too.
      for (const group of rail.querySelectorAll<HTMLElement>('.rail-group')) group.hidden = ![...group.querySelectorAll<HTMLButtonElement>('.rail-item')].some((button) => !button.hidden);
    },
    setStatus(text, kind = 'info', showRetry = false) {
      status.textContent = text;
      status.dataset.kind = kind;
      retry.hidden = !showRetry;
    },
    setTabs(active, worn) {
      if (active !== stripCategory) showAll = false;
      stripCategory = active;
      for (const tab of tabs.querySelectorAll<HTMLButtonElement>('.pill-tab')) {
        const category = tab.dataset.category as Category;
        tab.classList.toggle('is-active', category === active);
        tab.classList.toggle('has-item', worn.includes(category));
      }
    },
    renderStrip(items, selectedId) {
      stripItems = items;
      stripSelected = selectedId;
      drawStrip();
    },
    setSnapshotEnabled(enabled) {
      snap.disabled = !enabled;
    },
    setMode(mode) {
      modeLocal.classList.toggle('is-active', mode === 'local');
      modeAi.classList.toggle('is-active', mode === 'ai');
      aiPanel.hidden = mode !== 'ai';
    },
    setAiKey(key) {
      apiKey.value = key;
    },
    setSize(factor) {
      const percent = Math.round(factor * 100);
      size.value = String(percent);
      sizeValue.textContent = `${percent}%`;
    },
    setView(view) {
      for (const button of navButtons) button.dataset.active = String(button.dataset.view === view);
      // The open page's group unfolds, so the rail always shows where you are.
      const current = navButtons.find((button) => button.dataset.view === view)?.closest('.rail-group');
      if (current?.classList.contains('is-closed')) {
        current.classList.remove('is-closed');
        current.querySelector('.rail-group-head')?.setAttribute('aria-expanded', 'true');
      }
      for (const button of moreButtons) button.dataset.active = String(onMore(view));
      $<HTMLElement>('#viewKicker').textContent = VIEWS[view].kicker;
      $<HTMLElement>('#viewTitle').textContent = VIEWS[view].title;
      const camera = CAMERA_VIEWS.includes(view);
      $<HTMLElement>('#stageView').hidden = !camera;
      // Camera status, hand control and the render mode mean nothing on a page without the camera.
      $<HTMLElement>('.status-row').hidden = !camera;
      $<HTMLElement>('#handToggle').hidden = !camera;
      $<HTMLElement>('#galleryView').hidden = view !== 'gallery';
      $<HTMLElement>('#sitesView').hidden = view !== 'sites';
      $<HTMLElement>('#dashboardView').hidden = view !== 'dashboard';
      $<HTMLElement>('#opsView').hidden = !isOpsView(view);
      $<HTMLElement>('#sessionPanel').hidden = view !== 'session';
      $<HTMLElement>('#presetPanel').hidden = view !== 'presets';
      $<HTMLElement>('#gatePanel').hidden = view !== 'gate';
      $<HTMLElement>('#tryonPanel').hidden = view !== 'tryon';
      $<HTMLElement>('#boothPanel').hidden = view !== 'photobooth';
      $<HTMLElement>('#modes').hidden = !camera;
      for (const button of captureButtons) {
        button.setAttribute('aria-label', VIEWS[view].capture);
        button.title = VIEWS[view].capture;
      }
    },
    setHandControl(on) {
      handToggle.setAttribute('aria-pressed', String(on));
      $<HTMLElement>('#handHint').hidden = !on;
    },
    setGalleryCount(count) {
      for (const badge of countBadges) {
        badge.textContent = String(count);
        badge.hidden = count === 0;
      }
    },
  };
}
