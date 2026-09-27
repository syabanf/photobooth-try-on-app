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

/** Border pixels this close to the border colour count as a plain backdrop. */
const BORDER_MATCH = 24;
/** How far the backdrop may drift from the border colour, which covers soft shadows and vignettes. */
const BACKDROP_REACH = 90;
/** How far a pixel may differ from its neighbour and still continue the backdrop. */
const BACKDROP_STEP = 10;

/**
 * Makes the plain backdrop of a product photo transparent, so a hat shot on white, grey or beige
 * wears like a cutout. The fill starts at the border and spreads through pixels near the border
 * colour and near their neighbour, so soft shadows go while the product's own edge stops it. Only
 * the largest remaining shape stays, which drops museum labels and specks. Images that already
 * carry transparency, or whose border is busy, are left alone. Returns whether anything changed.
 */
export function clearBackdrop(data: Uint8ClampedArray, width: number, height: number): boolean {
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) return false;

  const border: number[] = [];
  for (let x = 0; x < width; x++) border.push(x, (height - 1) * width + x);
  for (let y = 1; y < height - 1; y++) border.push(y * width, y * width + width - 1);
  const median = (channel: number) => border.map((p) => data[p * 4 + channel]).sort((a, b) => a - b)[border.length >> 1];
  const ref = [median(0), median(1), median(2)];
  const distance = (p: number) =>
    Math.max(Math.abs(data[p * 4] - ref[0]), Math.abs(data[p * 4 + 1] - ref[1]), Math.abs(data[p * 4 + 2] - ref[2]));
  if (border.filter((p) => distance(p) < BORDER_MATCH).length < border.length * 0.6) return false;

  const count = width * height;
  const queue = new Int32Array(count);
  /** Breadth-first walk from `seeds` through the 4-neighbours `take` accepts and marks. Returns the size. */
  const fill = (seeds: number[], take: (from: number, p: number) => boolean) => {
    let head = 0;
    let tail = 0;
    for (const p of seeds) queue[tail++] = p;
    while (head < tail) {
      const p = queue[head++];
      const x = p % width;
      if (x > 0 && take(p, p - 1)) queue[tail++] = p - 1;
      if (x < width - 1 && take(p, p + 1)) queue[tail++] = p + 1;
      if (p >= width && take(p, p - width)) queue[tail++] = p - width;
      if (p < count - width && take(p, p + width)) queue[tail++] = p + width;
    }
    return tail;
  };

  const backdrop = new Uint8Array(count);
  const seeds = border.filter((p) => distance(p) < BACKDROP_REACH);
  for (const p of seeds) backdrop[p] = 1;
  fill(seeds, (from, p) => {
    if (backdrop[p] || distance(p) >= BACKDROP_REACH) return false;
    for (let c = 0; c < 3; c++) if (Math.abs(data[p * 4 + c] - data[from * 4 + c]) > BACKDROP_STEP) return false;
    backdrop[p] = 1;
    return true;
  });

  // Label what is left and keep the largest shape.
  const shape = new Int32Array(count);
  let label = 0;
  let largest = 0;
  let largestSize = 0;
  for (let seed = 0; seed < count; seed++) {
    if (backdrop[seed] || shape[seed]) continue;
    shape[seed] = ++label;
    const size = fill([seed], (_, p) => {
      if (backdrop[p] || shape[p]) return false;
      shape[p] = label;
      return true;
    });
    if (size > largestSize) {
      largestSize = size;
      largest = label;
    }
  }

  // Everything else goes, and the shape's outermost pixels fade by how close they sit to the backdrop.
  const kept = (p: number) => shape[p] === largest;
  for (let p = 0; p < count; p++) {
    if (!kept(p)) {
      data[p * 4 + 3] = 0;
      continue;
    }
    const x = p % width;
    const edge =
      (x > 0 && !kept(p - 1)) || (x < width - 1 && !kept(p + 1)) || (p >= width && !kept(p - width)) || (p < count - width && !kept(p + width));
    if (edge) data[p * 4 + 3] = Math.min(255, Math.round((distance(p) * 255) / BACKDROP_REACH));
  }
  return true;
}
