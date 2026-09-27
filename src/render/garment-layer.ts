// Composites a worn garment: warped photo, scene lighting, the shade under the chin, then the body
// parts that cross in front.

import type { Vec } from '../mls';
import type { SegmentMask } from '../tracking/segmenter';
import { buildGarmentMask } from './occlusion';
import { sizeCanvas } from './overlay';
import { SceneShade } from './shade';
import { drawWarpedImage } from './warp';

/** How strongly the scene's light and shade carries onto the garment. */
const SHADE_STRENGTH = 0.65;
/** The shadow the head casts on the collar: how dark at the neck, and how far it reaches in shoulder spans. */
const NECK_SHADOW = 0.26;
const NECK_SHADOW_REACH = 0.38;
/** Widest body mask built per frame. Softer than the camera, and cheap enough to redraw. */
const MASK_WIDTH = 224;

export class GarmentLayer {
  private readonly layer = document.createElement('canvas');
  private readonly layerCtx = this.layer.getContext('2d')!;
  private readonly shade = new SceneShade();
  private readonly body = document.createElement('canvas');
  private readonly bodyCtx = this.body.getContext('2d')!;
  private bodyPixels: ImageData | null = null;

  constructor() {
    this.layerCtx.imageSmoothingQuality = 'high';
  }

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
    /** The collar top on screen, where the head's shadow falls. */
    neck: Vec;
    torso: readonly Vec[];
  }): HTMLCanvasElement {
    const { width, height } = options;
    sizeCanvas(this.layer, width, height);
    this.layerCtx.clearRect(0, 0, width, height);
    drawWarpedImage(this.layerCtx, options.image, options.deform, options.columns, options.rows);

    this.shade.apply(this.layer, options.video, width, height, SHADE_STRENGTH);
    this.shadeNeck(options.neck, options.torso);
    if (options.mask) this.clipToBody(options.mask, options.torso, width, height);
    return this.layer;
  }

  /** A soft, wide shadow under the chin, which is what settles a collar onto the body. */
  private shadeNeck(neck: Vec, torso: readonly Vec[]): void {
    const ctx = this.layerCtx;
    const span = Math.hypot(torso[1].x - torso[0].x, torso[1].y - torso[0].y);
    const reach = span * NECK_SHADOW_REACH;
    ctx.save();
    ctx.globalCompositeOperation = 'source-atop';
    ctx.translate(neck.x, neck.y);
    // Twice as wide as it is deep: the chin shades across the collar, not far down it.
    ctx.scale(1, 0.5);
    const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, reach);
    gradient.addColorStop(0, `rgba(0, 0, 0, ${NECK_SHADOW})`);
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(-reach, -reach, reach * 2, reach * 2);
    ctx.restore();
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
    // Soften the cut at mask resolution, where a 1 px blur is cheap; nearest-neighbour steps read as pasted on.
    this.bodyCtx.filter = 'blur(1px)';
    this.bodyCtx.drawImage(this.body, 0, 0);
    this.bodyCtx.filter = 'none';

    this.layerCtx.globalCompositeOperation = 'destination-in';
    this.layerCtx.drawImage(this.body, 0, 0, width, height);
    this.layerCtx.globalCompositeOperation = 'source-over';
  }
}
