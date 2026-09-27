// Replaces the room behind the wearer. The backdrop is drawn over the video with a hole where the
// person is, so the live camera shows through that hole.

import { drawBackdrop, type Background } from '../backgrounds';
import type { SegmentMask } from '../tracking/segmenter';
import { buildBackgroundMask } from './occlusion';
import { sizeCanvas } from './overlay';

/** Shrink factor for the blurred room; a small copy blurs cheaply and softly when scaled back up. */
const BLUR_DOWNSCALE = 8;

export class BackgroundLayer {
  private readonly layer = document.createElement('canvas');
  private readonly layerCtx = this.layer.getContext('2d')!;
  private readonly small = document.createElement('canvas');
  private readonly smallCtx = this.small.getContext('2d')!;
  private readonly maskCanvas = document.createElement('canvas');
  private readonly maskCtx = this.maskCanvas.getContext('2d')!;
  private readonly soft = document.createElement('canvas');
  private readonly softCtx = this.soft.getContext('2d')!;
  private maskPixels: ImageData | null = null;

  /** The backdrop with the person cut out, or null when there is nothing to replace yet. */
  render(
    background: Background,
    video: HTMLVideoElement,
    mask: SegmentMask | null,
    width: number,
    height: number,
  ): HTMLCanvasElement | null {
    if (background.kind === 'none' || !mask) return null;
    // A scenery photo still downloading has nothing to draw yet.
    if (background.kind === 'image' && !background.image) return null;
    sizeCanvas(this.layer, width, height);
    const ctx = this.layerCtx;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, width, height);

    if (background.kind === 'blur') {
      const w = Math.max(1, Math.round(width / BLUR_DOWNSCALE));
      const h = Math.max(1, Math.round(height / BLUR_DOWNSCALE));
      sizeCanvas(this.small, w, h);
      this.smallCtx.filter = 'blur(3px)';
      this.smallCtx.drawImage(video, 0, 0, w, h);
      ctx.drawImage(this.small, 0, 0, width, height);
    } else {
      // The stage mirrors the canvas, so flip the backdrop here to have it read the right way round.
      ctx.save();
      ctx.translate(width, 0);
      ctx.scale(-1, 1);
      drawBackdrop(ctx, background, width, height);
      ctx.restore();
    }

    sizeCanvas(this.maskCanvas, mask.width, mask.height);
    sizeCanvas(this.soft, mask.width, mask.height);
    if (!this.maskPixels || this.maskPixels.width !== mask.width || this.maskPixels.height !== mask.height) {
      this.maskPixels = this.maskCtx.createImageData(mask.width, mask.height);
    }
    buildBackgroundMask(mask, this.maskPixels);
    this.maskCtx.putImageData(this.maskPixels, 0, 0);
    // Feather the cut at mask resolution, where a 1 px blur is cheap and softens the edge nicely.
    this.softCtx.clearRect(0, 0, mask.width, mask.height);
    this.softCtx.filter = 'blur(1px)';
    this.softCtx.drawImage(this.maskCanvas, 0, 0);

    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(this.soft, 0, 0, width, height);
    ctx.globalCompositeOperation = 'source-over';
    return this.layer;
  }
}
