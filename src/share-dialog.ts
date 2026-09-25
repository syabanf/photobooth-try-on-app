// The share sheet: lay a capture out for a social format, then share it, save it or copy it.

import { canvasToBlob, downloadBlob } from './render/overlay';
import { FRAMES, composeSocial, exportType, type SocialFill, type SocialFormat } from './social';
import { segmented } from './ui';

export interface ShareDialog {
  open(blob: Blob, baseName: string): Promise<void>;
}

/** Web Share with files opens the phone's own share sheet, which is how a web page reaches Instagram. */
function canShareFiles(): boolean {
  try {
    return typeof navigator.canShare === 'function' && navigator.canShare({ files: [new File([''], 'probe.jpg', { type: 'image/jpeg' })] });
  } catch {
    return false;
  }
}

export function mountShareDialog(): ShareDialog {
  const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;
  const root = $<HTMLElement>('#shareDialog');
  const preview = $<HTMLCanvasElement>('#sharePreview');
  const fillField = $<HTMLElement>('#shareFillField');
  const meta = $<HTMLElement>('#shareMeta');
  const send = $<HTMLButtonElement>('#shareSend');
  const copy = $<HTMLButtonElement>('#shareCopy');
  const copyLabel = copy.querySelector('span')!;

  let picture: ImageBitmap | null = null;
  let composed: HTMLCanvasElement | null = null;
  let name = 'try-on';
  let format: SocialFormat = 'post';
  let fill: SocialFill = 'blur';
  let returnFocus: HTMLElement | null = null;

  const save = $<HTMLButtonElement>('#shareSave');
  // Without file sharing, Save is the main action and takes the accent.
  if (!canShareFiles()) {
    send.hidden = true;
    save.classList.replace('btn-outline', 'btn-primary');
  }
  copy.hidden = typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write;

  function render(): void {
    if (!picture) return;
    composed = composeSocial(picture, format, fill);
    preview.width = composed.width;
    preview.height = composed.height;
    preview.getContext('2d')!.drawImage(composed, 0, 0);
    fillField.hidden = format === 'original';
    const size = `${composed.width} × ${composed.height} · ${exportType(format).extension.toUpperCase()}`;
    const safe = format === 'story' ? ` · top ${FRAMES.story.inset.top} px and bottom ${FRAMES.story.inset.bottom} px stay clear of Instagram's bars` : '';
    meta.textContent = size + safe;
  }

  const fileName = () => `${name}-${format}.${exportType(format).extension}`;

  async function encoded(): Promise<Blob> {
    const { type, quality } = exportType(format);
    return canvasToBlob(composed!, type, quality);
  }

  function close(): void {
    root.hidden = true;
    picture?.close();
    picture = null;
    returnFocus?.focus();
  }

  segmented($('#shareFormats'), (button) => {
    format = button.dataset.format as SocialFormat;
    render();
  });
  segmented($('#shareFills'), (button) => {
    fill = button.dataset.fill as SocialFill;
    render();
  });

  save.addEventListener('click', async () => downloadBlob(await encoded(), fileName()));
  send.addEventListener('click', async () => {
    const blob = await encoded();
    try {
      await navigator.share({ files: [new File([blob], fileName(), { type: blob.type })], title: 'Virtual Try-On' });
    } catch (e) {
      if ((e as DOMException).name !== 'AbortError') console.error(e);
    }
  });
  copy.addEventListener('click', async () => {
    try {
      // The clipboard only takes PNG images.
      const png = await canvasToBlob(composed!, 'image/png');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      copyLabel.textContent = 'Copied';
    } catch (e) {
      console.warn('Clipboard refused the image', e);
      copyLabel.textContent = 'Copy blocked';
    }
    setTimeout(() => (copyLabel.textContent = 'Copy'), 1800);
  });
  for (const closer of root.querySelectorAll('[data-close]')) closer.addEventListener('click', close);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !root.hidden) close();
  });

  return {
    async open(blob, baseName) {
      returnFocus = document.activeElement as HTMLElement | null;
      picture?.close();
      picture = await createImageBitmap(blob);
      name = baseName;
      root.hidden = false;
      render();
      root.querySelector<HTMLButtonElement>('.choice.is-active')?.focus();
    },
  };
}
