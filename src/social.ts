// Soft copies sized for Instagram: the picture sits whole inside the frame, over a blur of itself
// or a plain fill, with Stories keeping clear of the bars Instagram draws on top.

import { containRect, coverCrop, type Rect } from './fit';
import { token } from './theme';

export type SocialFormat = 'post' | 'square' | 'story' | 'original';
export type SocialFill = 'blur' | 'paper' | 'ink';

interface FrameSpec {
  width: number;
  height: number;
  /** Space kept free around the picture. */
  inset: { top: number; right: number; bottom: number; left: number };
}

const EDGE = 64;

export const FRAMES: Record<Exclude<SocialFormat, 'original'>, FrameSpec> = {
  /** 4:5, the tallest shape the feed shows without cropping. */
  post: { width: 1080, height: 1350, inset: { top: EDGE, right: EDGE, bottom: EDGE, left: EDGE } },
  square: { width: 1080, height: 1080, inset: { top: EDGE, right: EDGE, bottom: EDGE, left: EDGE } },
  /** 9:16. Instagram covers roughly the top 250 px with the profile row and the bottom with replies. */
  story: { width: 1080, height: 1920, inset: { top: 250, right: 72, bottom: 280, left: 72 } },
};

/** Where the picture lands inside a social frame: as large as fits inside the insets, centred there. */
export function placeInFrame(spec: FrameSpec, imageWidth: number, imageHeight: number): Rect {
  const { inset } = spec;
  const box = containRect(
    spec.width - inset.left - inset.right,
    spec.height - inset.top - inset.bottom,
    imageWidth,
    imageHeight,
  );
  return { x: box.x + inset.left, y: box.y + inset.top, w: box.w, h: box.h };
}

type Picture = CanvasImageSource & { width: number; height: number };

/** A small, blurred, darkened copy of the picture stretched over the whole frame. */
function paintBlur(ctx: CanvasRenderingContext2D, picture: Picture, width: number, height: number): void {
  const small = document.createElement('canvas');
  small.width = Math.max(1, Math.round(width / 16));
  small.height = Math.max(1, Math.round(height / 16));
  const smallCtx = small.getContext('2d')!;
  smallCtx.filter = 'blur(2px)';
  const crop = coverCrop(picture.width, picture.height, height / width);
  smallCtx.drawImage(picture, crop.x, crop.y, crop.w, crop.h, 0, 0, small.width, small.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(small, 0, 0, width, height);
  ctx.fillStyle = 'rgb(16 17 18 / 0.28)';
  ctx.fillRect(0, 0, width, height);
}

/** The picture laid out for a social format. `original` returns it untouched. */
export function composeSocial(picture: Picture, format: SocialFormat, fill: SocialFill): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  if (format === 'original') {
    canvas.width = picture.width;
    canvas.height = picture.height;
    canvas.getContext('2d')!.drawImage(picture, 0, 0);
    return canvas;
  }

  const spec = FRAMES[format];
  canvas.width = spec.width;
  canvas.height = spec.height;
  const ctx = canvas.getContext('2d')!;
  if (fill === 'blur') paintBlur(ctx, picture, spec.width, spec.height);
  else {
    ctx.fillStyle = token(fill === 'paper' ? '--surface' : '--ink');
    ctx.fillRect(0, 0, spec.width, spec.height);
  }

  const at = placeInFrame(spec, picture.width, picture.height);
  const radius = 24;
  ctx.save();
  ctx.shadowColor = 'rgb(16 17 18 / 0.3)';
  ctx.shadowBlur = 48;
  ctx.shadowOffsetY = 16;
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.roundRect(at.x, at.y, at.w, at.h, radius);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(at.x, at.y, at.w, at.h, radius);
  ctx.clip();
  ctx.drawImage(picture, at.x, at.y, at.w, at.h);
  ctx.restore();
  return canvas;
}

/** Social formats export as JPEG, which Instagram recompresses anyway; Original keeps PNG. */
export function exportType(format: SocialFormat): { type: string; extension: string; quality?: number } {
  return format === 'original' ? { type: 'image/png', extension: 'png' } : { type: 'image/jpeg', extension: 'jpg', quality: 0.92 };
}
