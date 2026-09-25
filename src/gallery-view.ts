// The gallery page: every saved snapshot and photobooth sheet, newest first.

import { deleteShot, listShots, type Shot } from './gallery';
import { icon, iconButton } from './icons';
import { downloadBlob } from './render/overlay';

export interface GalleryHandlers {
  onNewBooth(): void;
  onCount(count: number): void;
  onShare(shot: Shot): void;
  /** "Kiosk 1 · Grand Indonesia" for the point a shot came from, or null. */
  pointLabel(id: string | null | undefined): string | null;
}

export interface GalleryView {
  refresh(): Promise<void>;
}

const LAYOUT_LABELS = { strip: 'Strip', grid: 'Grid', single: 'Single' } as const;

function describe(shot: Shot): string {
  return shot.kind === 'photobooth' && shot.layout ? `Photobooth · ${LAYOUT_LABELS[shot.layout]}` : 'Snapshot';
}

export function mountGalleryView(handlers: GalleryHandlers): GalleryView {
  const grid = document.querySelector<HTMLElement>('#galleryGrid')!;
  const meta = document.querySelector<HTMLElement>('#galleryMeta')!;
  document.querySelector<HTMLButtonElement>('#galleryNewBooth')!.addEventListener('click', handlers.onNewBooth);
  let urls: string[] = [];

  function emptyState(): HTMLElement {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const tile = document.createElement('span');
    tile.className = 'empty-icon';
    tile.append(icon('images'));
    const title = document.createElement('p');
    title.className = 'empty-title';
    title.textContent = 'Nothing saved yet';
    const desc = document.createElement('p');
    desc.className = 'empty-desc';
    desc.textContent = 'Snapshots and photobooth sheets you take appear here.';
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'btn btn-outline btn-sm';
    action.textContent = 'Open photobooth';
    action.addEventListener('click', handlers.onNewBooth);
    empty.append(tile, title, desc, action);
    return empty;
  }

  function card(shot: Shot): HTMLElement {
    const url = URL.createObjectURL(shot.blob);
    urls.push(url);

    const article = document.createElement('article');
    article.className = 'shot';
    const frame = document.createElement('div');
    frame.className = 'shot-image';
    const img = document.createElement('img');
    img.src = url;
    img.alt = describe(shot);
    img.loading = 'lazy';
    frame.append(img);

    const when = document.createElement('div');
    when.className = 'shot-when';
    const kind = document.createElement('span');
    kind.className = 'shot-kind';
    kind.textContent = describe(shot);
    const date = document.createElement('span');
    date.className = 'shot-date';
    const point = handlers.pointLabel(shot.pointId);
    const stamp = new Date(shot.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    date.textContent = point ? `${stamp} · ${point}` : stamp;
    when.append(kind, date);

    const share = iconButton('share', 'Share');
    share.addEventListener('click', () => handlers.onShare(shot));

    const download = iconButton('download', 'Download');
    download.addEventListener('click', () => downloadBlob(shot.blob, `${shot.kind}-${shot.createdAt}.png`));

    // Two taps to delete: the first arms the button, the second removes the shot.
    const remove = iconButton('trash', 'Delete');
    let armTimer = 0;
    const disarm = () => {
      remove.className = 'btn btn-ghost btn-icon';
      remove.replaceChildren(icon('trash'));
    };
    remove.addEventListener('click', async () => {
      if (!remove.classList.contains('btn-armed')) {
        remove.className = 'btn btn-sm btn-armed';
        remove.replaceChildren('Delete?');
        armTimer = window.setTimeout(disarm, 3000);
        return;
      }
      clearTimeout(armTimer);
      await deleteShot(shot.id);
      await view.refresh();
    });

    const actions = document.createElement('div');
    actions.className = 'shot-actions';
    actions.append(share, download, remove);

    const footer = document.createElement('div');
    footer.className = 'shot-meta';
    footer.append(when, actions);
    article.append(frame, footer);
    return article;
  }

  const view: GalleryView = {
    async refresh() {
      const shots = await listShots();
      for (const url of urls) URL.revokeObjectURL(url);
      urls = [];
      const sheets = shots.filter((s) => s.kind === 'photobooth').length;
      meta.textContent =
        shots.length === 0 ? 'Saved on this device only.' : `${shots.length} saved · ${sheets} photobooth sheets`;
      grid.replaceChildren(...(shots.length ? shots.map(card) : [emptyState()]));
      handlers.onCount(shots.length);
    },
  };
  return view;
}
