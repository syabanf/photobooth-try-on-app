// Fitting one rectangle into another: whole and letterboxed, or cropped to fill.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where `object-fit: contain` puts content of the given size inside a box. */
export function containRect(boxWidth: number, boxHeight: number, contentWidth: number, contentHeight: number): Rect {
  if (contentWidth <= 0 || contentHeight <= 0) return { x: 0, y: 0, w: boxWidth, h: boxHeight };
  const scale = Math.min(boxWidth / contentWidth, boxHeight / contentHeight);
  const w = contentWidth * scale;
  const h = contentHeight * scale;
  return { x: (boxWidth - w) / 2, y: (boxHeight - h) / 2, w, h };
}

/** The centred part of a source image that fills a box of height/width `aspect` without stretching. */
export function coverCrop(sourceWidth: number, sourceHeight: number, aspect: number): Rect {
  const targetWidthPerHeight = 1 / aspect;
  if (sourceWidth / sourceHeight > targetWidthPerHeight) {
    const w = sourceHeight * targetWidthPerHeight;
    return { x: (sourceWidth - w) / 2, y: 0, w, h: sourceHeight };
  }
  const h = sourceWidth * aspect;
  return { x: 0, y: (sourceHeight - h) / 2, w: sourceWidth, h };
}
