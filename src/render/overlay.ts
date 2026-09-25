import type { Anchor, Rect } from '../anchors';

/** Resizes a canvas only when the size changes, since any assignment clears it. */
export function sizeCanvas(canvas: HTMLCanvasElement, width: number, height: number): void {
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
}

export class Overlay {
  readonly ctx: CanvasRenderingContext2D;

  constructor(readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unsupported');
    this.ctx = ctx;
  }

  resize(width: number, height: number): void {
    sizeCanvas(this.canvas, width, height);
  }

  clear(): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  draw(anchor: Anchor, img: CanvasImageSource, rect: Rect): void {
    const { ctx } = this;
    ctx.save();
    ctx.translate(anchor.cx, anchor.cy);
    ctx.rotate(anchor.angle);
    ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h);
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
