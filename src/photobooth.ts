// Photobooth: a timed run of shots composed into a printable strip, grid or single frame.

import { coverCrop, type Rect } from './fit';
import { token } from './theme';

export type BoothLayout = 'strip' | 'grid' | 'single';

export interface BoothSheet {
  width: number;
  height: number;
  cells: Rect[];
  caption: Rect;
}

interface LayoutSpec {
  columns: number;
  rows: number;
  cellWidth: number;
  padding: number;
  gap: number;
  captionHeight: number;
}

/** Every cell is 4:3 landscape, so a 16:9 camera frame loses its sides rather than its head. */
export const CELL_ASPECT = 3 / 4;

const SPECS: Record<BoothLayout, LayoutSpec> = {
  strip: { columns: 1, rows: 4, cellWidth: 600, padding: 32, gap: 20, captionHeight: 128 },
  grid: { columns: 2, rows: 2, cellWidth: 480, padding: 32, gap: 20, captionHeight: 128 },
  single: { columns: 1, rows: 1, cellWidth: 960, padding: 40, gap: 0, captionHeight: 148 },
};

export function shotsFor(layout: BoothLayout): number {
  return SPECS[layout].columns * SPECS[layout].rows;
}

/** Where each photo and the caption land on the printed sheet, in pixels. */
export function boothSheet(layout: BoothLayout): BoothSheet {
  const s = SPECS[layout];
  const cellHeight = Math.round(s.cellWidth * CELL_ASPECT);
  const width = s.padding * 2 + s.columns * s.cellWidth + (s.columns - 1) * s.gap;
  const gridHeight = s.rows * cellHeight + (s.rows - 1) * s.gap;

  const cells: Rect[] = [];
  for (let row = 0; row < s.rows; row++) {
    for (let col = 0; col < s.columns; col++) {
      cells.push({
        x: s.padding + col * (s.cellWidth + s.gap),
        y: s.padding + row * (cellHeight + s.gap),
        w: s.cellWidth,
        h: cellHeight,
      });
    }
  }

  return {
    width,
    height: s.padding * 2 + gridHeight + s.captionHeight,
    cells,
    caption: { x: s.padding, y: s.padding + gridHeight, w: width - s.padding * 2, h: s.captionHeight },
  };
}

export interface BoothFrame {
  id: string;
  label: string;
  /** CSS custom properties from the theme, resolved when the sheet is drawn. */
  paper: string;
  ink: string;
}

export const FRAMES: readonly BoothFrame[] = [
  { id: 'paper', label: 'Paper', paper: '--card', ink: '--ink' },
  { id: 'ink', label: 'Ink', paper: '--ink', ink: '--on-ink' },
  { id: 'accent', label: 'Coral', paper: '--accent', ink: '--on-ink' },
  { id: 'canvas', label: 'Canvas', paper: '--surface', ink: '--ink' },
];

/** Draws the shots onto one sheet with a caption and the date, ready to save or print. */
export async function composeBooth(
  shots: readonly HTMLCanvasElement[],
  layout: BoothLayout,
  frame: BoothFrame,
  caption: string,
  date: Date,
): Promise<HTMLCanvasElement> {
  const sheet = boothSheet(layout);
  const canvas = document.createElement('canvas');
  canvas.width = sheet.width;
  canvas.height = sheet.height;
  const ctx = canvas.getContext('2d')!;
  const paper = token(frame.paper);
  const ink = token(frame.ink);

  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, sheet.width, sheet.height);

  sheet.cells.forEach((cell, i) => {
    const shot = shots[i];
    if (!shot) return;
    const crop = coverCrop(shot.width, shot.height, CELL_ASPECT);
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(cell.x, cell.y, cell.w, cell.h, 16);
    ctx.clip();
    ctx.drawImage(shot, crop.x, crop.y, crop.w, crop.h, cell.x, cell.y, cell.w, cell.h);
    ctx.restore();
  });

  const titleSize = layout === 'single' ? 44 : 36;
  await document.fonts.load(`700 ${titleSize}px "DM Sans"`).catch(() => undefined);
  const centreX = sheet.caption.x + sheet.caption.w / 2;
  const titleY = sheet.caption.y + sheet.caption.h * 0.46;

  ctx.textBaseline = 'alphabetic';
  ctx.font = `700 ${titleSize}px "DM Sans", system-ui, sans-serif`;
  const title = caption.trim() || 'Virtual Try-On';
  const titleWidth = ctx.measureText(title).width;
  const periodWidth = ctx.measureText('.').width;
  const startX = centreX - (titleWidth + periodWidth) / 2;
  ctx.textAlign = 'left';
  ctx.fillStyle = ink;
  ctx.fillText(title, startX, titleY);
  // The house headline ends with an accent period; on an accent sheet it falls back to ink.
  ctx.fillStyle = frame.paper === '--accent' ? ink : token('--accent');
  ctx.fillText('.', startX + titleWidth, titleY);

  ctx.font = `500 ${Math.round(titleSize * 0.5)}px "DM Sans", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = ink;
  ctx.fillText(
    date.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }),
    centreX,
    titleY + titleSize * 0.95,
  );
  ctx.globalAlpha = 1;
  return canvas;
}

export interface BoothHooks {
  capture(): HTMLCanvasElement;
  countdown(seconds: number | null): void;
  flash(): void;
  shot(index: number, total: number, canvas: HTMLCanvasElement): void;
  cancelled(): boolean;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Counts down before every shot, then returns the captures, or null if the run was cancelled. */
export async function runBoothSession(
  total: number,
  countdownSeconds: number,
  hooks: BoothHooks,
): Promise<HTMLCanvasElement[] | null> {
  const shots: HTMLCanvasElement[] = [];
  for (let i = 0; i < total; i++) {
    for (let s = countdownSeconds; s > 0; s--) {
      if (hooks.cancelled()) return null;
      hooks.countdown(s);
      await wait(1000);
    }
    if (hooks.cancelled()) return null;
    hooks.countdown(null);
    hooks.flash();
    const shot = hooks.capture();
    shots.push(shot);
    hooks.shot(i, total, shot);
    await wait(700);
  }
  return shots;
}
