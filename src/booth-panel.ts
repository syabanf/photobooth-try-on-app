// Photobooth controls as a four-step flow (layout, background, stickers, print), plus the countdown,
// flash, progress and sheet preview drawn over the camera.

import { SCENERY, STUDIO_BACKGROUNDS, imageBackground, loadBackground, paintedBackdrop, type Background } from './backgrounds';
import { icon } from './icons';
import { FRAMES, shotsFor, type BoothFrame, type BoothLayout } from './photobooth';
import { STICKERS, type StickerDef } from './stickers';
import { segmented } from './ui';

export interface BoothSettings {
  layout: BoothLayout;
  frame: BoothFrame;
  seconds: number;
  caption: string;
}

export interface BoothPanelHandlers {
  onStart(): void;
  onCancel(): void;
  onOpenGallery(): void;
  /** Opens the share sheet for the finished sheet. */
  onShare(sheet: Blob): void;
  onBackground(background: Background): void;
  /** A backdrop under the mouse, shown on the camera until the pointer leaves; null when it leaves. */
  onBackgroundHover(background: Background | null): void;
  /** Any sheet setting changed, so the preview should redraw. */
  onSettingsChange(): void;
  onSticker(sticker: StickerDef): void;
  onClearStickers(): void;
}

export interface BoothPanel {
  settings(): BoothSettings;
  setRunning(running: boolean): void;
  setResult(blob: Blob): void;
  /** The sheet as it would print right now, shown on the camera; null hides it. */
  showPreview(sheet: HTMLCanvasElement | null): void;
  progress(done: number, total: number): void;
  countdown(seconds: number | null): void;
  flash(): void;
  hideHud(): void;
}

type Step = 0 | 1 | 2 | 3 | 'result';

const STEPS = [
  { hint: 'Pick how the shots sit on the sheet.' },
  { hint: 'Swap the room behind you, or keep it.' },
  { hint: 'Add stickers, then drag them into place on the camera.' },
  { hint: 'Choose the frame, timer and caption, then start.' },
] as const;
const LAST_STEP = 3;

export function mountBoothPanel(handlers: BoothPanelHandlers): BoothPanel {
  const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;
  const start = $<HTMLButtonElement>('#boothStart');
  const back = $<HTMLButtonElement>('#boothBack');
  const next = $<HTMLButtonElement>('#boothNext');
  const nav = $<HTMLElement>('#boothNav');
  const resultActions = $<HTMLElement>('#boothResultActions');
  const result = $<HTMLElement>('#boothResult');
  const hint = $<HTMLElement>('#boothStepHint');
  const count = $<HTMLElement>('#boothStepCount');
  const meta = $<HTMLElement>('#boothMeta');
  const stepper = $<HTMLElement>('#boothSteps');
  const steps = [...stepper.querySelectorAll<HTMLButtonElement>('.step')];
  const panels = [...document.querySelectorAll<HTMLElement>('.booth-flow .step-panel')];
  const hud = $<HTMLElement>('#boothHud');
  const shotLabel = $<HTMLElement>('#boothShotLabel');
  const dots = $<HTMLElement>('#boothDots');
  const countdownEl = $<HTMLElement>('#boothCountdown');
  const flashEl = $<HTMLElement>('#boothFlash');
  const frames = $<HTMLElement>('#boothFrames');
  const preview = $<HTMLElement>('#boothPreview');
  const previewCanvas = document.createElement('canvas');
  preview.append(previewCanvas);

  const settings: BoothSettings = { layout: 'strip', frame: FRAMES[0], seconds: 3, caption: 'Virtual Try-On' };
  let step: Step = 0;
  let running = false;
  let latest: { blob: Blob; url: string } | null = null;

  function goTo(target: Step): void {
    step = target;
    const index = target === 'result' ? LAST_STEP + 1 : target;
    for (const panel of panels) panel.hidden = panel.dataset.panel !== String(target);
    steps.forEach((button, i) => {
      button.classList.toggle('is-active', i === index);
      button.classList.toggle('is-done', i < index);
    });
    hint.textContent = target === 'result' ? 'Saved to the gallery on this device.' : STEPS[target].hint;
    count.textContent = target === 'result' ? 'Done' : `${target + 1} / ${STEPS.length}`;
    nav.hidden = target === 'result';
    stepper.hidden = target === 'result';
    resultActions.hidden = target !== 'result';
    back.disabled = target === 0;
    next.hidden = target === 'result' || target === LAST_STEP;
    start.hidden = target !== LAST_STEP;
  }

  /** Shot count and roughly how long the run takes, so there are no surprises after Start. */
  function describeRun(): void {
    const shots = shotsFor(settings.layout);
    const seconds = Math.round(shots * (settings.seconds + 0.7));
    meta.textContent = `${shots} ${shots === 1 ? 'shot' : 'shots'} · about ${seconds} s · or hold up ✌️ to start hands-free`;
  }

  function changed(): void {
    describeRun();
    handlers.onSettingsChange();
  }

  frames.replaceChildren(
    ...FRAMES.map((frame, i) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'swatch';
      button.classList.toggle('is-active', i === 0);
      button.dataset.frame = frame.id;
      button.style.background = `var(${frame.paper})`;
      button.setAttribute('aria-label', `${frame.label} frame`);
      button.title = frame.label;
      return button;
    }),
  );

  mountScene(handlers);

  segmented($('#boothLayouts'), (b) => {
    settings.layout = b.dataset.layout as BoothLayout;
    changed();
  });
  segmented($('#boothTimers'), (b) => {
    settings.seconds = Number(b.dataset.seconds);
    changed();
  });
  segmented(frames, (b) => {
    settings.frame = FRAMES.find((f) => f.id === b.dataset.frame) ?? FRAMES[0];
    $<HTMLElement>('#boothFrameName').textContent = settings.frame.label;
    changed();
  });
  $<HTMLInputElement>('#boothCaption').addEventListener('input', (event) => {
    settings.caption = (event.target as HTMLInputElement).value;
    changed();
  });

  steps.forEach((button, i) => button.addEventListener('click', () => goTo(i as Step)));
  back.addEventListener('click', () => {
    if (typeof step === 'number' && step > 0) goTo((step - 1) as Step);
  });
  next.addEventListener('click', () => {
    if (typeof step === 'number' && step < LAST_STEP) goTo((step + 1) as Step);
  });
  start.addEventListener('click', () => (running ? handlers.onCancel() : handlers.onStart()));
  $<HTMLButtonElement>('#boothAgain').addEventListener('click', () => goTo(0));
  $<HTMLButtonElement>('#boothOpenGallery').addEventListener('click', handlers.onOpenGallery);
  $<HTMLButtonElement>('#boothShare').addEventListener('click', () => {
    if (latest) handlers.onShare(latest.blob);
  });

  describeRun();
  goTo(0);

  return {
    settings: () => ({ ...settings }),
    setRunning(isRunning) {
      running = isRunning;
      // A run can start from the rail or a ✌️ on any step; show the Print step so Cancel is at hand.
      if (isRunning) goTo(LAST_STEP);
      const label = document.createElement('span');
      label.textContent = isRunning ? 'Cancel' : 'Start photobooth';
      start.replaceChildren(icon(isRunning ? 'close' : 'aperture'), label);
      start.classList.toggle('btn-primary', !isRunning);
      start.classList.toggle('btn-secondary', isRunning);
      back.disabled = isRunning;
      for (const button of steps) button.disabled = isRunning;
      if (isRunning) preview.hidden = true;
    },
    setResult(blob) {
      if (latest) URL.revokeObjectURL(latest.url);
      latest = { blob, url: URL.createObjectURL(blob) };
      const img = document.createElement('img');
      img.src = latest.url;
      img.alt = 'Latest photobooth sheet';
      result.replaceChildren(img);
      goTo('result');
      resultActions.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    },
    showPreview(sheet) {
      preview.hidden = !sheet;
      if (!sheet) return;
      if (previewCanvas.width !== sheet.width) previewCanvas.width = sheet.width;
      if (previewCanvas.height !== sheet.height) previewCanvas.height = sheet.height;
      previewCanvas.getContext('2d')!.drawImage(sheet, 0, 0);
    },
    progress(done, total) {
      hud.hidden = false;
      shotLabel.textContent = done >= total ? 'Printing…' : `Shot ${done + 1} of ${total}`;
      dots.replaceChildren(
        ...Array.from({ length: total }, (_, i) => {
          const dot = document.createElement('span');
          dot.classList.toggle('is-done', i < done);
          return dot;
        }),
      );
    },
    countdown(seconds) {
      countdownEl.hidden = seconds === null;
      countdownEl.textContent = seconds === null ? '' : String(seconds);
    },
    flash() {
      flashEl.classList.remove('is-flashing');
      void flashEl.offsetWidth; // restart the animation on back-to-back shots
      flashEl.classList.add('is-flashing');
    },
    hideHud() {
      hud.hidden = true;
      countdownEl.hidden = true;
    },
  };
}

/** Backdrop tiles, the upload tile and the sticker palette. */
function mountScene(handlers: BoothPanelHandlers): void {
  const scenery = document.querySelector<HTMLElement>('#sceneryGrid')!;
  const studio = document.querySelector<HTMLElement>('#boothBackgrounds')!;
  const upload = document.querySelector<HTMLInputElement>('#bgUpload')!;
  let custom: HTMLButtonElement | null = null;
  // Photos download on first use; these tokens let the latest pick or hover win a race.
  let pickToken = 0;
  let hoverToken = 0;

  const markActive = (id: string) => {
    for (const tile of document.querySelectorAll<HTMLElement>('.bg-tile')) {
      tile.classList.toggle('is-active', tile.dataset.bg === id);
    }
  };

  const withPhoto = async (tile: HTMLElement, background: Background) => {
    if (!background.src || background.image) return background;
    tile.classList.add('is-loading');
    try {
      return await loadBackground(background);
    } finally {
      tile.classList.remove('is-loading');
    }
  };

  const previewFor = (background: Background) => {
    const preview = document.createElement('span');
    preview.className = 'bg-preview';
    if (background.kind === 'none') preview.append(icon('close'));
    else if (background.kind === 'blur') preview.classList.add('bg-preview--blur');
    else if (background.thumb) preview.style.backgroundImage = `url("${background.thumb}")`;
    else if (background.image) preview.style.backgroundImage = `url("${background.image.src}")`;
    else preview.style.backgroundImage = `url("${paintedBackdrop(background, 96, 64).toDataURL()}")`;
    return preview;
  };

  const shell = (label: string, preview: HTMLElement) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'bg-tile';
    const caption = document.createElement('span');
    caption.textContent = label;
    button.append(preview, caption);
    return button;
  };

  const tile = (background: Background) => {
    const button = shell(background.label, previewFor(background));
    button.dataset.bg = background.id;
    button.addEventListener('click', async () => {
      const token = ++pickToken;
      markActive(background.id);
      try {
        const ready = await withPhoto(button, background);
        if (token === pickToken) handlers.onBackground(ready);
      } catch (e) {
        console.warn(e);
      }
    });
    // Mouse only: on touch the tap applies at once and is just as easy to undo.
    button.addEventListener('pointerenter', async (event) => {
      if (event.pointerType !== 'mouse') return;
      const token = ++hoverToken;
      try {
        const ready = await withPhoto(button, background);
        if (token === hoverToken) handlers.onBackgroundHover(ready);
      } catch (e) {
        console.warn(e);
      }
    });
    button.addEventListener('pointerleave', () => {
      hoverToken++;
      handlers.onBackgroundHover(null);
    });
    return button;
  };

  scenery.replaceChildren(...SCENERY.map(tile));
  studio.replaceChildren(...STUDIO_BACKGROUNDS.map(tile));
  markActive(STUDIO_BACKGROUNDS[0].id);

  const uploadPreview = document.createElement('span');
  uploadPreview.className = 'bg-preview bg-preview--upload';
  uploadPreview.append(icon('upload'));
  const uploadTile = shell('Upload', uploadPreview);
  uploadTile.addEventListener('click', () => upload.click());
  studio.append(uploadTile);

  upload.addEventListener('change', () => {
    const file = upload.files?.[0];
    upload.value = '';
    if (!file) return;
    const image = new Image();
    image.onload = () => {
      const background = imageBackground(image);
      custom?.remove();
      custom = tile(background);
      studio.insertBefore(custom, uploadTile);
      custom.click();
    };
    image.src = URL.createObjectURL(file);
  });

  segmented(document.querySelector<HTMLElement>('#bgTabs')!, (button) => {
    const showScenery = button.dataset.bgTab === 'scenery';
    scenery.hidden = !showScenery;
    studio.hidden = showScenery;
  });

  const palette = document.querySelector<HTMLElement>('#boothStickers')!;
  palette.replaceChildren(
    ...STICKERS.map((sticker) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `sticker-pick${sticker.kind === 'badge' ? ' sticker-pick--badge' : ''}`;
      button.textContent = sticker.text;
      button.setAttribute('aria-label', `Add ${sticker.id} sticker`);
      button.addEventListener('click', () => handlers.onSticker(sticker));
      return button;
    }),
  );
  document.querySelector<HTMLButtonElement>('#stickerClear')!.addEventListener('click', handlers.onClearStickers);
}
