import { CATEGORY_LABELS, loadImage, type CatalogItem, type Category } from './catalog';
import { openDialog } from './dialogs';
import { hydrateIcons, icon, type IconName } from './icons';

export type Mode = 'local' | 'ai';
export type View = 'dashboard' | 'tryon' | 'photobooth' | 'gallery' | 'sites';

/** Views that show the camera stage. */
export const CAMERA_VIEWS: readonly View[] = ['tryon', 'photobooth'];
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
  dashboard: { kicker: 'Overview', title: 'Dashboard', capture: 'Open camera' },
  tryon: { kicker: 'Virtual try-on', title: 'Try on', capture: 'Take snapshot' },
  photobooth: { kicker: 'Timed shots', title: 'Photobooth', capture: 'Start photobooth' },
  gallery: { kicker: 'Saved on this device', title: 'Gallery', capture: 'Open camera' },
  sites: { kicker: 'Master data', title: 'Locations', capture: 'Open camera' },
};

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
    stripMore.textContent = expanded ? 'Show fewer' : `Show all ${stripItems.length}`;
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

  // Phones: the bottom bar has room for five slots, so Gallery and Locations sit behind More.
  const more = $<HTMLButtonElement>('#barMore');
  const MORE_VIEWS: [View, string, IconName][] = [
    ['gallery', 'Gallery', 'images'],
    ['sites', 'Locations', 'pin'],
  ];
  more.addEventListener('click', () => {
    const rows = MORE_VIEWS.map(([view, label, iconName]) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'pick-row';
      row.dataset.close = '';
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
    // data-close on each row shuts the sheet after the view switches.
    openDialog({ title: 'More', body: rows, footer: [] });
  });

  const setRailExpanded = (expanded: boolean) => {
    rail.classList.toggle('is-expanded', expanded);
    railToggle.setAttribute('aria-label', expanded ? 'Collapse menu' : 'Expand menu');
    writeStored(RAIL_KEY, expanded ? '1' : '0');
  };
  setRailExpanded(readStored(RAIL_KEY) === '1');
  railToggle.addEventListener('click', () => setRailExpanded(!rail.classList.contains('is-expanded')));

  return {
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
      more.dataset.active = String(view === 'gallery' || view === 'sites');
      $<HTMLElement>('#viewKicker').textContent = VIEWS[view].kicker;
      $<HTMLElement>('#viewTitle').textContent = VIEWS[view].title;
      const camera = CAMERA_VIEWS.includes(view);
      $<HTMLElement>('#stageView').hidden = !camera;
      $<HTMLElement>('#galleryView').hidden = view !== 'gallery';
      $<HTMLElement>('#sitesView').hidden = view !== 'sites';
      $<HTMLElement>('#dashboardView').hidden = view !== 'dashboard';
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
