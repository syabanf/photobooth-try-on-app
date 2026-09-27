import type { Placement } from './anchors';
import { measureGarment, type GarmentShape } from './garment';
import { clearBackdrop, traceSilhouette } from './image-bounds';

export type Category = 'glasses' | 'hat' | 'clothing';

export interface CatalogItem {
  id: string;
  name: string;
  category: Category;
  src: string;
  scale: number;
  /** In units of anchor width. */
  offsetX: number;
  /** In units of anchor width. Negative moves the item up. Unused by clothing. */
  offsetY: number;
  /** Fraction of the image height that sits on the anchor point. Unused by clothing. */
  pivotY?: number;
  /** Photo credit, for items under a license that asks for one. */
  credit?: string;
}

export const CATEGORY_LABELS: Record<Category, string> = {
  glasses: 'Glasses',
  hat: 'Hats',
  clothing: 'Clothing',
};

export const CATEGORY_DEFAULTS: Record<Category, Placement> = {
  glasses: { scale: 1.7, offsetX: 0, offsetY: 0, pivotY: 0.5 },
  hat: { scale: 1.4, offsetX: 0, offsetY: 0.2, pivotY: 1 },
  // Clothing is warped onto the pose skeleton, so only `scale` applies. Pose shoulder landmarks
  // mark the joint centers, which sit well inside the shoulder outline, so a garment that covers
  // the body has to reach about half again as wide.
  clothing: { scale: 1.45, offsetX: 0, offsetY: 0, pivotY: 0 },
};

export const DEFAULT_ITEMS: CatalogItem[] = [
  { id: 'glasses-round', name: 'Round', category: 'glasses', src: '/items/glasses-round.png', scale: 1.7, offsetX: 0, offsetY: 0 },
  { id: 'glasses-aviator', name: 'Aviator', category: 'glasses', src: '/items/glasses-aviator.png', scale: 1.75, offsetX: 0, offsetY: 0.02 },
  { id: 'hat-cap', name: 'Cap', category: 'hat', src: '/items/hat-cap.png', scale: 1.4, offsetX: 0, offsetY: 0.12 },
  { id: 'hat-beanie', name: 'Beanie', category: 'hat', src: '/items/hat-beanie.png', scale: 1.35, offsetX: 0, offsetY: 0.1 },
  { id: 'shirt-tee', name: 'Tee', category: 'clothing', src: '/items/shirt-tee.png', scale: 1.45, offsetX: 0, offsetY: 0 },
  { id: 'jacket-hoodie', name: 'Hoodie', category: 'clothing', src: '/items/jacket-hoodie.png', scale: 1.5, offsetX: 0, offsetY: 0 },
];

export function placementOf(item: CatalogItem, sizeFactor = 1): Placement {
  return {
    scale: item.scale * sizeFactor,
    offsetX: item.offsetX,
    offsetY: item.offsetY,
    pivotY: item.pivotY ?? CATEGORY_DEFAULTS[item.category].pivotY,
  };
}

/** A drawable item image, cropped to its opaque pixels, with the garment outline when measurable. */
export interface ItemImage {
  source: CanvasImageSource & { width: number; height: number };
  width: number;
  height: number;
  shape: GarmentShape | null;
}

const imageCache = new Map<string, Promise<ItemImage>>();

export function loadImage(src: string): Promise<ItemImage> {
  let pending = imageCache.get(src);
  if (!pending) {
    pending = new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Could not load ${src}`));
      img.src = src;
    }).then(prepareImage);
    imageCache.set(src, pending);
  }
  return pending;
}

/**
 * Clears a plain photo backdrop, crops the transparent padding and measures the garment, so sizing
 * follows the item itself.
 */
function prepareImage(img: HTMLImageElement): ItemImage {
  const full = document.createElement('canvas');
  full.width = img.naturalWidth;
  full.height = img.naturalHeight;
  const ctx = full.getContext('2d')!;
  ctx.drawImage(img, 0, 0);

  let pixels: ImageData;
  try {
    pixels = ctx.getImageData(0, 0, full.width, full.height);
  } catch {
    // Cross-origin without CORS headers: draw the photo as it came.
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, shape: null };
  }
  const { data } = pixels;
  if (clearBackdrop(data, full.width, full.height)) ctx.putImageData(pixels, 0, 0);

  const { bounds, rows } = traceSilhouette(data, full.width, full.height);
  const cropped = document.createElement('canvas');
  cropped.width = bounds.w;
  cropped.height = bounds.h;
  cropped.getContext('2d')!.drawImage(full, bounds.x, bounds.y, bounds.w, bounds.h, 0, 0, bounds.w, bounds.h);
  return {
    source: cropped,
    width: bounds.w,
    height: bounds.h,
    shape: measureGarment(rows, bounds.h / bounds.w),
  };
}

let uploadCount = 0;

export function createUploadItem(file: File, category: Category): CatalogItem {
  uploadCount += 1;
  const defaults = CATEGORY_DEFAULTS[category];
  return {
    id: `upload-${uploadCount}`,
    name: file.name.replace(/\.png$/i, '') || `Upload ${uploadCount}`,
    category,
    src: URL.createObjectURL(file),
    scale: defaults.scale,
    offsetX: defaults.offsetX,
    offsetY: defaults.offsetY,
  };
}
