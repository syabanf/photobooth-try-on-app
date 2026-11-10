// Fills AI preset templates with chosen faces. The booth's preset panel and the self-service kiosk
// both draw from here, so a template looks the same wherever the customer picks it.

import { canvasToBlob } from '../../render/overlay';
import { blobUrl } from '../blobs';
import type { FaceRecord, Preset } from '../model';
import type { Ops } from '../ops';
import { renderPreset, suggestPreset, type PresetLook } from '../presets';

export interface Render {
  preset: Preset;
  canvas: HTMLCanvasElement;
  url: string;
}

const imageOf = (blobId: string) => blobUrl(blobId).then((url) => fetch(url)).then((response) => response.blob()).then((blob) => createImageBitmap(blob));

/** Decoded faces, cached by id for as long as the screen lives. */
export function faceBitmaps(): (face: FaceRecord) => Promise<ImageBitmap> {
  const cache = new Map<string, Promise<ImageBitmap>>();
  return (face) => {
    let bitmap = cache.get(face.id);
    if (!bitmap) {
      bitmap = imageOf(face.image);
      cache.set(face.id, bitmap);
    }
    return bitmap;
  };
}

/** Built-in and custom presets, plus every active uploaded frame as a template of its own. */
export function presetTemplates(ops: Ops): Preset[] {
  const frames = ops.state.frames
    .filter((frame) => frame.active && frame.slots.length)
    .map((frame): Preset => ({ id: `frame:${frame.id}`, name: frame.name, layout: 'frame', frameId: frame.id, active: true, builtIn: false, prompt: 'Make this a polished printed photo in its frame: even studio light, true colours and crisp detail, the frame artwork left exactly as it is.' }));
  return [...ops.state.aiPresets.filter((preset) => preset.active && (preset.layout !== 'frame' || preset.frameId)), ...frames];
}

async function lookFor(ops: Ops, preset: Preset): Promise<PresetLook> {
  const { branding } = ops.state;
  const base: PresetLook = { brand: branding.brandName || ops.account.business, accent: branding.accent, ink: branding.ink, date: new Date() };
  const frame = ops.state.frames.find((entry) => entry.id === preset.frameId);
  if (preset.layout !== 'frame' || !frame) return base;
  return { ...base, frame: { frame, image: await imageOf(frame.image) } };
}

/** Every template filled with the faces, the suggested one first. Skips a template that fails. */
export async function* fillTemplates(ops: Ops, faces: readonly ImageBitmap[]): AsyncGenerator<Render> {
  const all = presetTemplates(ops);
  const suggested = suggestPreset(all, faces.length);
  for (const preset of [...all].sort((a, b) => Number(b.id === suggested?.id) - Number(a.id === suggested?.id))) {
    try {
      const canvas = await renderPreset(preset, faces, await lookFor(ops, preset));
      yield { preset, canvas, url: URL.createObjectURL(await canvasToBlob(canvas, 'image/jpeg', 0.9)) };
    } catch (error) {
      console.warn(`Preset ${preset.name} skipped`, error);
    }
  }
}
