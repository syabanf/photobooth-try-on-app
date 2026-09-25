// Composites a worn garment: warped photo, scene lighting, then the body parts that cross in front.

import type { Vec } from '../mls';
import type { SegmentMask } from '../tracking/segmenter';
import { buildGarmentMask } from './occlusion';
import { sizeCanvas } from './overlay';
import { drawWarpedImage } from './warp';

/** Width of the downsampled frame the shading is taken from. Small enough to read as soft light. */
const SHADE_WIDTH = 48;
/** How strongly the scene's light and shade carries onto the garment. */
const SHADE_STRENGTH = 0.65;
/** Widest body mask built per frame. Softer than the camera, and cheap enough to redraw. */
const MASK_WIDTH = 224;

export class GarmentLayer {
  private readonly layer = document.createElement('canvas');
  private readonly layerCtx = this.layer.getContext('2d')!;
  private readonly shade = document.createElement('canvas');
  private readonly shadeCtx = this.shade.getContext('2d')!;
  private readonly small = document.createElement('canvas');
  private readonly smallCtx = this.small.getContext('2d')!;
  private readonly body = document.createElement('canvas');
  private readonly bodyCtx = this.body.getContext('2d')!;
  private bodyPixels: ImageData | null = null;

  /** Draws the garment and returns the canvas to composite onto the overlay. */
  render(options: {
    image: CanvasImageSource & { width: number; height: number };
    deform: (p: Vec) => Vec;
    columns: number;
    rows: number;
    video: HTMLVideoElement;
    width: number;
    height: number;
    mask: SegmentMask | null;
    torso: readonly Vec[];
  }): HTMLCanvasElement {
    const { width, height } = options;
    sizeCanvas(this.layer, width, height);
    this.layerCtx.clearRect(0, 0, width, height);
    drawWarpedImage(this.layerCtx, options.image, options.deform, options.columns, options.rows);

    this.applyShading(options.video, width, height);
    if (options.mask) this.clipToBody(options.mask, options.torso, width, height);
    return this.layer;
  }

  /** Blends a blurred copy of the frame over the garment so it picks up the room's light. */
  private applyShading(video: HTMLVideoElement, width: number, height: number): void {
    const smallHeight = Math.max(1, Math.round((SHADE_WIDTH * height) / width));
    sizeCanvas(this.small, SHADE_WIDTH, smallHeight);
    this.smallCtx.filter = 'grayscale(1)';
    this.smallCtx.drawImage(video, 0, 0, SHADE_WIDTH, smallHeight);

    sizeCanvas(this.shade, width, height);
    this.shadeCtx.globalCompositeOperation = 'source-over';
    this.shadeCtx.globalAlpha = 1;
    this.shadeCtx.clearRect(0, 0, width, height);
    this.shadeCtx.drawImage(this.small, 0, 0, width, height);
    // Keep the shading inside the garment so it cannot tint the frame around it.
    this.shadeCtx.globalCompositeOperation = 'destination-in';
    this.shadeCtx.drawImage(this.layer, 0, 0);

    this.layerCtx.globalCompositeOperation = 'soft-light';
    this.layerCtx.globalAlpha = SHADE_STRENGTH;
    this.layerCtx.drawImage(this.shade, 0, 0);
    this.layerCtx.globalAlpha = 1;
    this.layerCtx.globalCompositeOperation = 'source-over';
  }

  /** Trims the garment to the body outline and lets whatever passes in front show through. */
  private clipToBody(mask: SegmentMask, torso: readonly Vec[], width: number, height: number): void {
    const maskHeight = Math.max(1, Math.round((MASK_WIDTH * height) / width));
    sizeCanvas(this.body, MASK_WIDTH, maskHeight);
    if (!this.bodyPixels || this.bodyPixels.height !== maskHeight) {
      this.bodyPixels = this.bodyCtx.createImageData(MASK_WIDTH, maskHeight);
    }
    buildGarmentMask(mask, torso, { width, height }, this.bodyPixels);
    this.bodyCtx.putImageData(this.bodyPixels, 0, 0);

    this.layerCtx.globalCompositeOperation = 'destination-in';
    this.layerCtx.drawImage(this.body, 0, 0, width, height);
    this.layerCtx.globalCompositeOperation = 'source-over';
  }
}
