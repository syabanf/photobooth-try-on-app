// AI presets beside the camera: capture a face, pick faces from everyone captured, see every
// template already filled with them, then have the AI redraw the one you like.

import { readStoredKey, restylePreset, storeKey } from '../../decart';
import { saveShot } from '../../gallery';
import { iconButton } from '../../icons';
import { canvasToBlob } from '../../render/overlay';
import { blobUrl } from '../blobs';
import type { FaceRecord, Preset } from '../model';
import type { Ops } from '../ops';
import { PRESET_SIZE, renderPreset, suggestPreset, type PresetLook } from '../presets';
import { act, actionButton, badge, el, notice } from './kit';
import { confirmDialog } from '../../dialogs';

export interface PresetHooks {
  /** A 4:5 headshot of whoever faces the camera; throws when no face is found. */
  captureFace(): Promise<HTMLCanvasElement>;
  countdown(seconds: number | null): void;
  flash(): void;
  share(blob: Blob, name: string): void;
  onSaved(): void;
}

type Step = 'capture' | 'faces' | 'templates' | 'result';

interface Render {
  preset: Preset;
  canvas: HTMLCanvasElement;
  url: string;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function mountPresetPanel(ops: Ops, hooks: PresetHooks) {
  const panel = document.querySelector<HTMLElement>('#presetPanel')!;
  let visible = false;
  let step: Step = 'capture';
  let busy = '';
  /** Faces captured since this customer started, for the "only this visit" library. */
  const visit = new Set<string>();
  const selected = new Set<string>();
  let renders: Render[] = [];
  let chosen: Render | null = null;
  let aiBlob: Blob | null = null;
  let aiUrl = '';
  let showAi = false;
  let renderToken = 0;
  const bitmaps = new Map<string, Promise<ImageBitmap>>();

  const faceBitmap = (face: FaceRecord) => {
    let bitmap = bitmaps.get(face.id);
    if (!bitmap) {
      bitmap = blobUrl(face.image).then((url) => fetch(url)).then((response) => response.blob()).then((blob) => createImageBitmap(blob));
      bitmaps.set(face.id, bitmap);
    }
    return bitmap;
  };

  /** The library the booth shows: every face kept, or only this customer's, as Settings says. */
  const library = () => ops.state.faces.filter((face) => ops.state.settings.faceLibrary === 'all' || visit.has(face.id));

  /** Built-in and custom presets, plus every active uploaded frame as a template of its own. */
  function templates(): Preset[] {
    const frames = ops.state.frames
      .filter((frame) => frame.active && frame.slots.length)
      .map((frame): Preset => ({ id: `frame:${frame.id}`, name: frame.name, layout: 'frame', frameId: frame.id, active: true, builtIn: false, prompt: 'Make this a polished printed photo in its frame: even studio light, true colours and crisp detail, the frame artwork left exactly as it is.' }));
    return [...ops.state.aiPresets.filter((preset) => preset.active && (preset.layout !== 'frame' || preset.frameId)), ...frames];
  }

  function card(title: string, description: string, ...content: (Node | string)[]): HTMLElement {
    const section = el('section', 'card');
    const head = el('header', 'card-head');
    const text = el('div');
    text.append(el('h2', 'card-title', title), el('p', 'card-desc', description));
    head.append(text);
    const body = el('div', 'card-body');
    body.append(...content);
    section.append(head, body);
    return section;
  }

  function go(next: Step): void {
    step = next;
    draw();
  }

  // ---------- 1. capture ----------
  async function capture(): Promise<void> {
    busy = 'Look at the camera…';
    draw();
    try {
      for (let s = 3; s > 0; s--) {
        hooks.countdown(s);
        await wait(1000);
      }
      hooks.countdown(null);
      hooks.flash();
      const crop = await hooks.captureFace();
      const face = await ops.addFace(await canvasToBlob(crop, 'image/jpeg', 0.92), ops.hooks.devicePointId());
      visit.add(face.id);
      selected.add(face.id);
      busy = '';
      go('faces');
    } catch (error) {
      hooks.countdown(null);
      busy = '';
      notice((error as Error).message, 'error');
      draw();
    }
  }

  function captureStep(): HTMLElement {
    const start = actionButton(busy || 'Capture my face', 'btn btn-primary btn-block');
    start.disabled = !!busy;
    start.addEventListener('click', () => void capture());
    const library = actionButton(`Choose from ${ops.state.faces.length} saved faces`, 'btn btn-outline btn-block');
    library.hidden = ops.state.settings.faceLibrary !== 'all' || ops.state.faces.length === 0;
    library.addEventListener('click', () => go('faces'));
    return card('AI presets', 'We take a photo of your face, then put it into every template. Pick one and the AI makes it real.', start, library);
  }

  // ---------- 2. faces ----------
  function facesStep(): HTMLElement {
    const faces = library();
    const grid = el('div', 'face-grid');
    for (const face of faces) {
      const tile = el('button', `face-tile${selected.has(face.id) ? ' is-selected' : ''}`);
      tile.type = 'button';
      tile.setAttribute('aria-pressed', String(selected.has(face.id)));
      const img = el('img');
      img.alt = 'Captured face';
      void blobUrl(face.image).then((url) => (img.src = url));
      tile.append(img);
      if (visit.has(face.id)) tile.append(badge('New', 'ok'));
      tile.addEventListener('click', () => {
        if (selected.has(face.id)) selected.delete(face.id);
        else selected.add(face.id);
        draw();
      });
      const remove = iconButton('trash', 'Delete this face');
      remove.classList.add('face-remove');
      remove.addEventListener('click', (event) => {
        event.stopPropagation();
        confirmDialog({
          title: 'Delete this face?',
          message: 'It leaves the face list and cannot be used again. Photos already made with it stay in the gallery.',
          confirmLabel: 'Delete',
          async run() {
            selected.delete(face.id);
            visit.delete(face.id);
            await ops.deleteFace(face.id);
            draw();
          },
        });
      });
      const wrap = el('div', 'face-cell');
      wrap.append(tile, remove);
      grid.append(wrap);
    }
    if (faces.length === 0) grid.append(el('p', 'card-desc', 'No faces yet. Capture one first.'));

    const tools = el('div', 'field-row');
    tools.append(
      act('Select all', 'btn btn-ghost btn-sm', () => {
        for (const face of faces) selected.add(face.id);
        draw();
      }),
      act('Clear', 'btn btn-ghost btn-sm', () => {
        selected.clear();
        draw();
      }),
      act('Capture another', 'btn btn-outline btn-sm', () => void capture(), 'camera'),
    );
    const next = actionButton(selected.size ? `Use ${selected.size} ${selected.size === 1 ? 'face' : 'faces'}` : 'Pick a face', 'btn btn-primary btn-block');
    next.disabled = selected.size === 0;
    next.addEventListener('click', () => {
      go('templates');
      void renderAll();
    });
    const scope = ops.state.settings.faceLibrary === 'all' ? `Every face captured here in the last ${ops.state.settings.retentionDays || '∞'} days.` : 'Faces from this visit only.';
    return card('Faces', `${scope} Tap to pick one or several.`, tools, grid, next);
  }

  // ---------- 3. templates ----------
  function look(preset: Preset): Promise<PresetLook> {
    const { branding } = ops.state;
    const base: PresetLook = { brand: branding.brandName || ops.account.business, accent: branding.accent, ink: branding.ink, date: new Date() };
    const frame = ops.state.frames.find((entry) => entry.id === preset.frameId);
    if (preset.layout !== 'frame' || !frame) return Promise.resolve(base);
    return blobUrl(frame.image)
      .then((url) => fetch(url))
      .then((response) => response.blob())
      .then((blob) => createImageBitmap(blob))
      .then((image) => ({ ...base, frame: { frame, image } }));
  }

  /** Fills every template with the chosen faces, newest choice first. */
  async function renderAll(): Promise<void> {
    const token = ++renderToken;
    for (const render of renders) URL.revokeObjectURL(render.url);
    renders = [];
    const faces = await Promise.all(ops.state.faces.filter((face) => selected.has(face.id)).map(faceBitmap));
    // The suggested template renders first, so the customer sees it straight away.
    const all = templates();
    const suggested = suggestPreset(all, selected.size);
    for (const preset of [...all].sort((a, b) => Number(b.id === suggested?.id) - Number(a.id === suggested?.id))) {
      try {
        const canvas = await renderPreset(preset, faces, await look(preset));
        if (token !== renderToken) return;
        renders.push({ preset, canvas, url: URL.createObjectURL(await canvasToBlob(canvas, 'image/jpeg', 0.9)) });
        if (step === 'templates') draw();
      } catch (error) {
        console.warn(`Preset ${preset.name} skipped`, error);
      }
    }
  }

  function templatesStep(): HTMLElement {
    const suggested = suggestPreset(templates(), selected.size);
    const grid = el('div', 'preset-grid');
    for (const render of renders) {
      const tile = el('button', `preset-tile${render.preset.id === suggested?.id ? ' is-suggested' : ''}`);
      tile.type = 'button';
      const img = el('img');
      img.src = render.url;
      img.alt = render.preset.name;
      tile.append(img, el('span', 'rank-name', render.preset.name));
      if (render.preset.id === suggested?.id) tile.append(badge('Suggested', 'info'));
      tile.addEventListener('click', () => {
        chosen = render;
        clearAi();
        go('result');
      });
      grid.append(tile);
    }
    if (renders.length < templates().length) grid.append(el('p', 'card-desc', 'Filling templates…'));
    const back = act('Change faces', 'btn btn-ghost btn-block', () => go('faces'));
    return card('Templates with you in them', 'Each one already has your face. Tap the one you like.', grid, back);
  }

  // ---------- 4. result ----------
  function clearAi(): void {
    if (aiUrl) URL.revokeObjectURL(aiUrl);
    aiBlob = null;
    aiUrl = '';
    showAi = false;
  }

  async function makeAi(): Promise<void> {
    const key = readStoredKey();
    if (!key) throw new Error('Paste a Decart API key first.');
    busy = 'The AI is redrawing your template…';
    draw();
    try {
      const template = await canvasToBlob(chosen!.canvas, 'image/jpeg', 0.92);
      aiBlob = await restylePreset(key, template, chosen!.preset.prompt);
      aiUrl = URL.createObjectURL(aiBlob);
      showAi = true;
    } finally {
      busy = '';
      draw();
    }
  }

  async function current(): Promise<Blob> {
    return showAi && aiBlob ? aiBlob : canvasToBlob(chosen!.canvas, 'image/jpeg', 0.92);
  }

  function resultStep(): HTMLElement {
    const preview = el('img', 'preset-result');
    preview.src = showAi && aiUrl ? aiUrl : chosen!.url;
    preview.alt = chosen!.preset.name;
    preview.style.aspectRatio = `${PRESET_SIZE.width} / ${PRESET_SIZE.height}`;

    const ai = el('div', 'form-stack');
    if (!readStoredKey()) {
      const keyRow = el('div', 'field-row');
      const key = el('input', 'input');
      key.type = 'password';
      key.placeholder = 'Decart API key, to make it with AI';
      key.autocomplete = 'off';
      keyRow.append(key, act('Save key', 'btn btn-outline', () => {
        if (!key.value.trim()) throw new Error('Paste the key.');
        storeKey(key.value.trim());
        draw();
      }));
      ai.append(keyRow, el('p', 'field-hint', 'The key stays in this tab and is dropped when it closes. Each AI image is billed by Decart.'));
    } else if (aiBlob) {
      const toggle = el('div', 'pill-tabs pill-tabs--full');
      for (const [value, label] of [[true, 'AI'], [false, 'Template']] as const) {
        const button = el('button', `pill-tab${showAi === value ? ' is-active' : ''}`, label);
        button.type = 'button';
        button.addEventListener('click', () => {
          showAi = value;
          draw();
        });
        toggle.append(button);
      }
      ai.append(toggle);
    } else {
      const make = actionButton(busy || 'Make it with AI', 'btn btn-primary btn-block');
      make.disabled = !!busy;
      make.addEventListener('click', () => makeAi().catch((error) => notice(`AI: ${(error as { message?: string })?.message ?? error}`, 'error')));
      ai.append(make);
    }

    const actions = el('div', 'field-row');
    const booth = ops.hooks.devicePointId();
    actions.append(
      act('Save', 'btn btn-secondary', async () => {
        await saveShot(await current(), 'preset', booth);
        hooks.onSaved();
        notice('Saved to the gallery.', 'ok');
      }, 'download'),
      act('Share', 'btn btn-outline', async () => hooks.share(await current(), `${chosen!.preset.id}-${Date.now()}`), 'share'),
    );
    if (booth) {
      actions.append(
        act('Print', 'btn btn-outline', async () => {
          const printer = await ops.print(booth, await current(), ops.printSizeFor(booth), 1);
          notice(`Printing on ${printer}.`, 'ok');
        }, 'printer'),
      );
    }
    const back = act('Other templates', 'btn btn-ghost', () => go('templates'));
    const done = act('Done', 'btn btn-ghost', () => {
      selected.clear();
      visit.clear();
      clearAi();
      go('capture');
    });
    const nav = el('div', 'field-row');
    nav.append(back, done);
    return card(chosen!.preset.name, showAi ? 'Made by AI from your template.' : 'Your template. Make it with AI for a real photo look.', preview, ai, actions, nav);
  }

  function draw(): void {
    if (!visible) return;
    const steps: Record<Step, () => HTMLElement> = { capture: captureStep, faces: facesStep, templates: templatesStep, result: resultStep };
    panel.replaceChildren(steps[step]());
  }

  // A face deleted elsewhere, a preset edited, a new frame: redraw the list steps.
  ops.store.subscribe(() => {
    for (const id of selected) if (!ops.state.faces.some((face) => face.id === id)) selected.delete(id);
    if (step === 'faces' || step === 'capture') draw();
  });

  return {
    show(): void {
      visible = true;
      draw();
    },
    hide(): void {
      visible = false;
    },
  };
}
