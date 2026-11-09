import type { ShotKind } from '../gallery';
import { extensionOf } from '../gallery-view';
import { downloadBlob } from '../render/overlay';
import { el } from './ui/kit';

export interface DeliveryFile {
  id: string;
  kind: ShotKind;
  blob: Blob;
}

/** The booth can check its local photo service; a phone scan still confirms LAN access. */
export async function photoDeliveryCheck(): Promise<string | null> {
  try {
    const response = await fetch('/api/delivery-config', { cache: 'no-store' });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return null;
    const config = (await response.json()) as { publicOrigin?: string };
    return config.publicOrigin?.replace(/\/$/, '') || null;
  } catch {
    return null;
  }
}

/** Publishes a finished session to the booth's local photo server. No server means no QR. */
export async function publishGallery(token: string, brand: string, files: DeliveryFile[], retentionDays: number): Promise<string | null> {
  try {
    const publicOrigin = await photoDeliveryCheck();
    if (!publicOrigin || !files.length) return null;
    for (const file of files) {
      const response = await fetch(`/api/gallery/${token}/${file.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': file.blob.type },
        body: file.blob,
      });
      if (!response.ok) throw new Error(`File upload failed (${response.status}).`);
    }
    const response = await fetch(`/api/gallery/${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brand, retentionDays, files: files.map(({ id, kind }) => ({ id, kind })) }),
    });
    if (!response.ok) throw new Error(`Gallery upload failed (${response.status}).`);
    return `${publicOrigin}/#g=${token}`;
  } catch (error) {
    console.warn('Customer gallery unavailable', error);
    return null;
  }
}

interface RemoteGallery {
  brand: string;
  files: { id: string; kind: ShotKind }[];
}

/** Opens a gallery from the photo server without a workspace sign-in on the customer's phone. */
export async function renderRemoteGallery(token: string): Promise<boolean> {
  try {
    const response = await fetch(`/api/gallery/${encodeURIComponent(token)}`);
    if (!response.headers.get('content-type')?.includes('application/json')) return false;
    if (!response.ok) {
      document.body.classList.add('display-mode');
      const root = el('main', 'display display--gallery');
      root.append(el('h1', 'display-title', response.status === 410 ? 'These photos have expired' : 'Photos unavailable'));
      document.body.replaceChildren(root);
      return true;
    }
    const gallery = (await response.json()) as RemoteGallery;
    if (!Array.isArray(gallery.files) || !gallery.files.length) return false;
    document.body.classList.add('display-mode');
    const root = el('main', 'display display--gallery');
    const head = el('header', 'display-head');
    head.append(el('span', 'display-brand', gallery.brand || 'Your photos'));
    const content = el('section', 'display-content');
    const canUseShare = isSecureContext && typeof navigator.share === 'function';
    content.append(el('h1', 'display-title', 'Your photos'), el('p', 'display-label', canUseShare ? 'Download or share the files you want to keep.' : 'Download your files, then open them in your photo or social app.'));
    const consent = el('label', 'consent-gate');
    const box = el('input') as HTMLInputElement;
    box.type = 'checkbox';
    consent.append(box, ' I agree to share these photos outside this page');
    const grid = el('div', 'gallery-public');
    for (const file of gallery.files) {
      const url = `/api/gallery/${encodeURIComponent(token)}/${encodeURIComponent(file.id)}`;
      const card = el('figure', 'public-shot');
      const motion = file.kind === 'video' || file.kind === 'live' || file.kind === 'bts';
      const media = motion ? el('video') as HTMLVideoElement : el('img') as HTMLImageElement;
      media.src = url;
      if (motion) {
        (media as HTMLVideoElement).controls = true;
        (media as HTMLVideoElement).playsInline = true;
      } else (media as HTMLImageElement).alt = file.kind;
      const actions = el('figcaption', 'public-actions');
      const save = el('button', 'btn btn-outline btn-sm', 'Download') as HTMLButtonElement;
      save.type = 'button';
      save.addEventListener('click', async () => {
        const blob = await fetch(url).then((r) => r.blob());
        downloadBlob(blob, `${file.kind}-${file.id}.${extensionOf(blob)}`);
      });
      actions.append(save);
      let feedback: HTMLElement | null = null;
      if (canUseShare) {
        const share = el('button', 'btn btn-primary btn-sm', 'Share') as HTMLButtonElement;
        share.type = 'button';
        share.disabled = true;
        box.addEventListener('change', () => (share.disabled = !box.checked));
        feedback = el('p', 'field-hint');
        feedback.hidden = true;
        share.addEventListener('click', async () => {
          const blob = await fetch(url).then((r) => r.blob());
          const item = new File([blob], `${file.kind}.${extensionOf(blob)}`, { type: blob.type });
          if (navigator.canShare && !navigator.canShare({ files: [item] })) {
            feedback!.textContent = 'This browser cannot share this file. Use Download instead.';
            feedback!.hidden = false;
            return;
          }
          try { await navigator.share({ files: [item], title: gallery.brand }); }
          catch (error) {
            if ((error as DOMException).name !== 'AbortError') {
              feedback!.textContent = 'Sharing failed. Use Download instead.';
              feedback!.hidden = false;
            }
          }
        });
        actions.append(share);
      }
      card.append(media, actions);
      if (feedback) card.append(feedback);
      grid.append(card);
    }
    if (canUseShare) content.append(consent);
    content.append(grid);
    root.append(head, content);
    document.body.replaceChildren(root);
    return true;
  } catch {
    return false;
  }
}
