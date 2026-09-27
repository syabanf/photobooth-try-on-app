// Scene lighting for a drawn item: a blurred copy of the frame blended over it, so it picks up the
// room's light and the body's shading instead of reading as a sticker with its own light.

import { sizeCanvas } from './overlay';

/** Width of the downsampled frame the shading is taken from. Small enough to read as soft light. */
const SHADE_WIDTH = 48;

export class SceneShade {
  private readonly small = document.createElement('canvas');
  private readonly smallCtx = this.small.getContext('2d')!;
  private readonly shade = document.createElement('canvas');
  private readonly shadeCtx = this.shade.getContext('2d')!;

  /** Blends the frame's light over the opaque pixels of `layer`, by `strength` from 0 to 1. */
  apply(layer: HTMLCanvasElement, video: CanvasImageSource, width: number, height: number, strength: number): void {
    const smallHeight = Math.max(1, Math.round((SHADE_WIDTH * height) / width));
    sizeCanvas(this.small, SHADE_WIDTH, smallHeight);
    this.smallCtx.filter = 'grayscale(1)';
    this.smallCtx.drawImage(video, 0, 0, SHADE_WIDTH, smallHeight);

    sizeCanvas(this.shade, width, height);
    this.shadeCtx.globalCompositeOperation = 'source-over';
    this.shadeCtx.clearRect(0, 0, width, height);
    this.shadeCtx.drawImage(this.small, 0, 0, width, height);
    // Keep the shading inside the item so it cannot tint the frame around it.
    this.shadeCtx.globalCompositeOperation = 'destination-in';
    this.shadeCtx.drawImage(layer, 0, 0);

    const ctx = layer.getContext('2d')!;
    ctx.globalCompositeOperation = 'soft-light';
    ctx.globalAlpha = strength;
    ctx.drawImage(this.shade, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}
