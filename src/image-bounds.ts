// Reads the opaque silhouette of an RGBA buffer so garments scale by the item, not the photo frame.

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Left and right opaque edge of one row, as fractions of the bounds width. */
export interface RowEdges {
  left: number;
  right: number;
}

export interface Silhouette {
  bounds: Bounds;
  /** One entry per row of `bounds`, top to bottom. Null where the row is fully transparent. */
  rows: Array<RowEdges | null>;
}

const ALPHA_THRESHOLD = 16;

/** Bounding box of pixels with alpha above the threshold, or the full frame when nothing is opaque. */
export function alphaBounds(data: Uint8ClampedArray, width: number, height: number): Bounds {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (data[row + x * 4 + 3] > ALPHA_THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { x: 0, y: 0, w: width, h: height };
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** Bounding box plus the per-row outline, both taken from the alpha channel in one pass. */
export function traceSilhouette(data: Uint8ClampedArray, width: number, height: number): Silhouette {
  const bounds = alphaBounds(data, width, height);
  const rows: Array<RowEdges | null> = [];
  for (let i = 0; i < bounds.h; i++) {
    const row = (bounds.y + i) * width * 4;
    let left = -1;
    let right = -1;
    for (let x = bounds.x; x < bounds.x + bounds.w; x++) {
      if (data[row + x * 4 + 3] > ALPHA_THRESHOLD) {
        if (left < 0) left = x;
        right = x;
      }
    }
    rows.push(left < 0 ? null : { left: (left - bounds.x) / bounds.w, right: (right - bounds.x) / bounds.w });
  }
  return { bounds, rows };
}
