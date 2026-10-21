// Print sizes, printer choice for a booth, and paper counting.

import type { PaperSize, Printer } from './model';

export const PAPER: Record<PaperSize, { label: string; widthMm: number; heightMm: number }> = {
  '2R': { label: '2R · 6.4 × 8.9 cm', widthMm: 64, heightMm: 89 },
  '3R': { label: '3R · 8.9 × 12.7 cm', widthMm: 89, heightMm: 127 },
  '4R': { label: '4R · 10.2 × 15.2 cm', widthMm: 102, heightMm: 152 },
  '5R': { label: '5R · 12.7 × 17.8 cm', widthMm: 127, heightMm: 178 },
  '6R': { label: '6R · 15.2 × 20.3 cm', widthMm: 152, heightMm: 203 },
  '8R': { label: '8R · 20.3 × 25.4 cm', widthMm: 203, heightMm: 254 },
  A4: { label: 'A4 · 21 × 29.7 cm', widthMm: 210, heightMm: 297 },
  A3: { label: 'A3 · 29.7 × 42 cm', widthMm: 297, heightMm: 420 },
  panoramic: { label: 'Panoramic · 10.2 × 30.5 cm', widthMm: 102, heightMm: 305 },
  custom: { label: 'Custom', widthMm: 100, heightMm: 150 },
};

export const PAPER_SIZES = Object.keys(PAPER) as PaperSize[];

export type PaperState = 'ok' | 'low' | 'empty';

export function paperState(printer: Pick<Printer, 'paperLeft' | 'lowThreshold'>): PaperState {
  if (printer.paperLeft <= 0) return 'empty';
  return printer.paperLeft <= printer.lowThreshold ? 'low' : 'ok';
}

/**
 * The printer for a job: it serves the booth (printers can be shared between booths), takes the
 * size, is working, and has paper. Among those, the one with the most paper goes first so the
 * load spreads out.
 */
export function pickPrinter(printers: readonly Printer[], boothId: string, size: PaperSize): Printer | null {
  const ready = printers.filter(
    (printer) => printer.boothIds.includes(boothId) && printer.sizes.includes(size) && printer.status === 'ok' && printer.paperLeft > 0,
  );
  return ready.sort((a, b) => b.paperLeft - a.paperLeft)[0] ?? null;
}

/** Why no printer can take a job, for the operator. */
export function noPrinterReason(printers: readonly Printer[], boothId: string, size: PaperSize): string {
  const mine = printers.filter((printer) => printer.boothIds.includes(boothId));
  if (mine.length === 0) return 'No printer is assigned to this booth.';
  const sized = mine.filter((printer) => printer.sizes.includes(size));
  if (sized.length === 0) return `No printer here takes ${size}.`;
  if (sized.every((printer) => printer.status !== 'ok')) return `${sized[0].name}: ${sized[0].error || sized[0].status}.`;
  return `${sized[0].name} is out of paper.`;
}

/** Counts paper down after a job. DNP printers overwrite this with their own reading. */
export function afterPrint(printer: Printer, sheets: number): Printer {
  return { ...printer, paperLeft: Math.max(0, printer.paperLeft - sheets) };
}
