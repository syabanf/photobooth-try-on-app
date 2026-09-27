import type { HeadFrame, Rect } from '../anchors';
import type { Vec } from '../mls';
import { SceneShade } from './shade';

/** How strongly the room's light carries onto glasses and hats. */
const RIGID_SHADE = 0.5;

/** Resizes a canvas only when the size changes, since any assignment clears it. */
export function sizeCanvas(canvas: HTMLCanvasElement, width: number, height: number): void {
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
}

export interface ItemShadow {
  /** How far the shadow falls along the head's down axis, in frame widths. */
  drop: number;
  /** Blur radius, in frame widths. */
  blur: number;
  alpha: number;
}

export interface WornItem {
  frame: HeadFrame;
  image: CanvasImageSource & { width: number; height: number };
  /** In the frame's own coordinates, from `itemRect`. */
  rect: Rect;
  shadow: ItemShadow;
  /** The face outline the shadow is kept inside; null draws no shadow. */
  face: readonly Vec[] | null;
  video: HTMLVideoElement;
}

const silhouettes = new WeakMap<object, HTMLCanvasElement>();

/** The item's opaque shape in black, made once per image, for casting its shadow. */
function silhouette(image: WornItem['image']): HTMLCanvasElement {
  let canvas = silhouettes.get(image);
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(image, 0, 0);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    silhouettes.set(image, canvas);
  }
  return canvas;
}

export class Overlay {
  readonly ctx: CanvasRenderingContext2D;
  private readonly layer = document.createElement('canvas');
  private readonly layerCtx = this.layer.getContext('2d')!;
  private readonly shade = new SceneShade();

  constructor(readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unsupported');
    this.ctx = ctx;
    ctx.imageSmoothingQuality = 'high';
    this.layerCtx.imageSmoothingQuality = 'high';
  }

  resize(width: number, height: number): void {
    sizeCanvas(this.canvas, width, height);
  }

  clear(): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Draws a worn item along the head's axes: its shadow on the face first, then the item lit by the room. */
  draw(item: WornItem): void {
    const { width, height } = this.canvas;
    const { frame, rect } = item;
    if (item.face) this.castShadow(item, item.face);

    sizeCanvas(this.layer, width, height);
    this.layerCtx.clearRect(0, 0, width, height);
    this.layerCtx.save();
    this.layerCtx.setTransform(frame.right.x, frame.right.y, frame.down.x, frame.down.y, frame.origin.x, frame.origin.y);
    this.layerCtx.drawImage(item.image, rect.x, rect.y, rect.w, rect.h);
    this.layerCtx.restore();
    this.shade.apply(this.layer, item.video, width, height, RIGID_SHADE);
    this.ctx.drawImage(this.layer, 0, 0);
  }

  /** The item's shape, dropped down the face and blurred, and kept off the room behind the head. */
  private castShadow({ frame, rect, shadow, image }: WornItem, face: readonly Vec[]): void {
    const { ctx } = this;
    const drop = shadow.drop * frame.width;
    ctx.save();
    ctx.beginPath();
    face.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.clip();
    ctx.filter = `blur(${(shadow.blur * frame.width).toFixed(1)}px)`;
    ctx.globalAlpha = shadow.alpha;
    ctx.setTransform(
      frame.right.x,
      frame.right.y,
      frame.down.x,
      frame.down.y,
      frame.origin.x + frame.down.x * drop,
      frame.origin.y + frame.down.y * drop,
    );
    ctx.drawImage(silhouette(image), rect.x, rect.y, rect.w, rect.h);
    ctx.restore();
  }

  /** Large centered number. Drawn flipped so it reads correctly through the mirrored stage. */
  drawCountdown(seconds: number): void {
    const { ctx, canvas } = this;
    const size = Math.round(canvas.height * 0.3);
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.scale(-1, 1);
    ctx.font = `700 ${size}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = size * 0.08;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillStyle = '#fff';
    ctx.strokeText(String(seconds), 0, 0);
    ctx.fillText(String(seconds), 0, 0);
    ctx.restore();
  }
}

/**
 * Mirrored copy of what the viewer sees: the video, plus the overlay when there is one. Decart
 * mode passes its generated stream and no overlay, since the garment is already in the picture.
 */
export function captureFrame(video: HTMLVideoElement, overlay: HTMLCanvasElement | null): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = video.videoWidth;
  out.height = video.videoHeight;
  const ctx = out.getContext('2d')!;
  // Restore afterwards: callers draw on this canvas in screen orientation, stickers included.
  ctx.save();
  ctx.translate(out.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, 0, 0);
  if (overlay) ctx.drawImage(overlay, 0, 0, out.width, out.height);
  ctx.restore();
  return out;
}

export function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/png', quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode the image'))), type, quality);
  });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
