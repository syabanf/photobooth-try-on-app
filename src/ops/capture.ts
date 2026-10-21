// Booth capture: effects baked into each frame, GIF bursts, and recorded clips.

import { encodeGif } from './encoders';
import type { Effects } from './model';

const FILTERS: Record<Effects['filter'], string> = {
  none: '',
  mono: 'grayscale(1) contrast(1.08)',
  warm: 'sepia(0.22) saturate(1.15)',
  cool: 'hue-rotate(-12deg) saturate(0.9) brightness(1.04)',
  vintage: 'sepia(0.55) contrast(0.9) brightness(1.06) saturate(0.85)',
  vivid: 'saturate(1.5) contrast(1.1)',
};

export const FILTER_LABELS: Record<Effects['filter'], string> = {
  none: 'Natural',
  mono: 'Mono',
  warm: 'Warm',
  cool: 'Cool',
  vintage: 'Vintage',
  vivid: 'Vivid',
};

/** The CSS filter for the live preview, and the same string for the canvas when capturing. */
export function cssFilter(effects: Effects): string {
  return [FILTERS[effects.filter], `brightness(${effects.brightness}%)`, `contrast(${effects.contrast}%)`, `saturate(${effects.saturation}%)`].filter(Boolean).join(' ');
}

/**
 * Applies the effects to a frame that arrives mirrored, the way the screen shows it: zoom crops
 * the middle, the filter is drawn in, and "no mirror" flips it back to the camera's own view.
 */
export function applyEffects(frame: HTMLCanvasElement, effects: Effects): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = frame.width;
  out.height = frame.height;
  const ctx = out.getContext('2d')!;
  const zoom = Math.max(1, effects.zoom);
  const sw = frame.width / zoom;
  const sh = frame.height / zoom;
  ctx.filter = cssFilter(effects) || 'none';
  if (!effects.mirror) {
    ctx.translate(out.width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(frame, (frame.width - sw) / 2, (frame.height - sh) / 2, sw, sh, 0, 0, out.width, out.height);
  return out;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A burst of frames as a looping GIF, scaled down so it stays small enough to share. */
export async function gifBurst(grab: () => HTMLCanvasElement, frames = 12, gapMs = 160, width = 480): Promise<Blob> {
  const shots: { data: Uint8ClampedArray; width: number; height: number }[] = [];
  for (let i = 0; i < frames; i++) {
    const frame = grab();
    const height = Math.round((frame.height / frame.width) * width);
    const small = document.createElement('canvas');
    small.width = width;
    small.height = height;
    const ctx = small.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(frame, 0, 0, width, height);
    shots.push({ data: ctx.getImageData(0, 0, width, height).data, width, height });
    await wait(gapMs);
  }
  // Play it forward then back, the boomerang most booths use.
  const loop = [...shots, ...shots.slice(1, -1).reverse()];
  return new Blob([encodeGif(loop, Math.round(gapMs / 10)) as BlobPart], { type: 'image/gif' });
}

function recorderType(): string {
  for (const type of ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

/** Records what `grab` draws, frame by frame, for `seconds`, as a clip with effects and try-on in. */
export async function recordFrames(grab: () => HTMLCanvasElement, seconds: number, fps = 24): Promise<Blob> {
  const first = grab();
  const canvas = document.createElement('canvas');
  canvas.width = first.width;
  canvas.height = first.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(first, 0, 0);
  const stream = canvas.captureStream(fps);
  const type = recorderType();
  const recorder = new MediaRecorder(stream, type ? { mimeType: type, videoBitsPerSecond: 4_000_000 } : undefined);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => event.data.size && chunks.push(event.data);
  const done = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));
  recorder.start(250);
  let running = true;
  const draw = () => {
    if (!running) return;
    ctx.drawImage(grab(), 0, 0, canvas.width, canvas.height);
    requestAnimationFrame(draw);
  };
  draw();
  await wait(seconds * 1000);
  running = false;
  recorder.stop();
  await done;
  stream.getTracks().forEach((track) => track.stop());
  return new Blob(chunks, { type: (type || 'video/webm').split(';')[0] });
}

/** Records a second camera, such as a BTS or CCTV angle, until the returned stop is called. */
export async function recordCamera(deviceId: string): Promise<() => Promise<Blob | null>> {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } }, audio: false });
  const type = recorderType();
  const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => event.data.size && chunks.push(event.data);
  const done = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));
  recorder.start(1000);
  return async () => {
    recorder.stop();
    await done;
    stream.getTracks().forEach((track) => track.stop());
    return chunks.length ? new Blob(chunks, { type: (type || 'video/webm').split(';')[0] }) : null;
  };
}
