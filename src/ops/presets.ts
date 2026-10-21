// AI preset templates drawn on the device: each layout places the chosen faces into a designed
// page at 1080 × 1350 (Instagram's 4:5). The AI pass then redraws the page from the preset's prompt.

import { composeFrame } from './frames';
import type { Frame, Preset } from './model';

export const PRESET_SIZE = { width: 1080, height: 1350 };

export const LAYOUT_LABELS: Record<Preset['layout'], string> = {
  cover: 'Magazine cover',
  polaroid: 'Polaroid',
  poster: 'Movie poster',
  pass: 'VIP pass',
  squad: 'Group of faces',
  frame: 'Uploaded frame',
};

export interface PresetLook {
  brand: string;
  accent: string;
  ink: string;
  date: Date;
  /** The frame for the frame layout, with its picture decoded. */
  frame?: { frame: Frame; image: CanvasImageSource };
}

type Face = HTMLCanvasElement | ImageBitmap;

const FONT = '"DM Sans", system-ui, sans-serif';

/** Draws a face so it covers the box, cropped from the middle. */
function cover(ctx: CanvasRenderingContext2D, face: Face, x: number, y: number, width: number, height: number): void {
  const scale = Math.max(width / face.width, height / face.height);
  const sw = width / scale;
  const sh = height / scale;
  ctx.drawImage(face, (face.width - sw) / 2, (face.height - sh) / 2, sw, sh, x, y, width, height);
}

function rounded(ctx: CanvasRenderingContext2D, face: Face, x: number, y: number, width: number, height: number, radius: number): void {
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  ctx.clip();
  cover(ctx, face, x, y, width, height);
  ctx.restore();
}

function text(ctx: CanvasRenderingContext2D, value: string, x: number, y: number, size: number, weight: number, colour: string, align: CanvasTextAlign = 'left', spacing = 0): void {
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.fillStyle = colour;
  ctx.textAlign = align;
  ctx.letterSpacing = `${spacing}px`;
  ctx.fillText(value, x, y);
  ctx.letterSpacing = '0px';
}

/** Shrinks a font until the text fits the width. */
function fitSize(ctx: CanvasRenderingContext2D, value: string, max: number, weight: number, width: number): number {
  let size = max;
  ctx.font = `${weight} ${size}px ${FONT}`;
  while (size > 24 && ctx.measureText(value).width > width) {
    size -= 4;
    ctx.font = `${weight} ${size}px ${FONT}`;
  }
  return size;
}

const monthYear = (date: Date) => date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
const longDate = (date: Date) => date.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });

export async function renderPreset(preset: Preset, faces: readonly Face[], look: PresetLook): Promise<HTMLCanvasElement> {
  if (faces.length === 0) throw new Error('Pick at least one face.');
  await document.fonts.load(`800 40px "DM Sans"`).catch(() => undefined);
  const { width, height } = PRESET_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.textBaseline = 'alphabetic';
  const brand = (look.brand || 'Photobooth').toUpperCase();
  const [first] = faces;

  if (preset.layout === 'cover') {
    cover(ctx, first, 0, 0, width, height);
    const shade = ctx.createLinearGradient(0, 0, 0, height);
    shade.addColorStop(0, 'rgb(0 0 0 / 0.45)');
    shade.addColorStop(0.3, 'rgb(0 0 0 / 0)');
    shade.addColorStop(0.65, 'rgb(0 0 0 / 0)');
    shade.addColorStop(1, 'rgb(0 0 0 / 0.65)');
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, width, height);
    text(ctx, brand, width / 2, 190, fitSize(ctx, brand, 190, 900, width - 80), 900, '#fff', 'center', -4);
    text(ctx, monthYear(look.date).toUpperCase(), width / 2, 250, 30, 700, '#fff', 'center', 6);
    ctx.fillStyle = look.accent;
    ctx.beginPath();
    ctx.arc(width - 150, 420, 92, 0, Math.PI * 2);
    ctx.fill();
    text(ctx, 'NEW', width - 150, 412, 46, 900, '#fff', 'center');
    text(ctx, 'ISSUE', width - 150, 450, 24, 700, '#fff', 'center', 3);
    text(ctx, 'The face of', 60, height - 210, 44, 600, '#fff');
    text(ctx, 'the season', 60, height - 140, 88, 900, '#fff');
    text(ctx, 'Exclusive shoot inside the booth', 60, height - 80, 32, 500, 'rgb(255 255 255 / 0.85)');
  } else if (preset.layout === 'polaroid') {
    ctx.fillStyle = look.accent;
    ctx.fillRect(0, 0, width, height);
    ctx.save();
    ctx.translate(width / 2, height / 2);
    ctx.rotate(-0.045);
    const cardW = 820;
    const cardH = 1000;
    ctx.shadowColor = 'rgb(0 0 0 / 0.35)';
    ctx.shadowBlur = 50;
    ctx.shadowOffsetY = 20;
    ctx.fillStyle = '#fbfaf7';
    ctx.fillRect(-cardW / 2, -cardH / 2, cardW, cardH);
    ctx.shadowColor = 'transparent';
    const inset = 50;
    cover(ctx, first, -cardW / 2 + inset, -cardH / 2 + inset, cardW - inset * 2, cardW - inset * 2);
    text(ctx, look.brand || 'Photobooth', 0, cardH / 2 - 130, 52, 700, '#222', 'center');
    text(ctx, longDate(look.date), 0, cardH / 2 - 70, 30, 500, '#777', 'center');
    ctx.restore();
  } else if (preset.layout === 'poster') {
    ctx.fillStyle = look.ink;
    ctx.fillRect(0, 0, width, height);
    const faceH = 1050;
    const faceW = faceH * 0.8;
    ctx.save();
    ctx.globalAlpha = 0.95;
    cover(ctx, first, (width - faceW) / 2, 70, faceW, faceH);
    ctx.restore();
    const vignette = ctx.createRadialGradient(width / 2, 560, 200, width / 2, 600, 720);
    vignette.addColorStop(0, 'rgb(0 0 0 / 0)');
    vignette.addColorStop(1, look.ink);
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, width, height);
    const fade = ctx.createLinearGradient(0, 800, 0, height);
    fade.addColorStop(0, 'rgb(0 0 0 / 0)');
    fade.addColorStop(0.6, look.ink);
    ctx.fillStyle = fade;
    ctx.fillRect(0, 800, width, height - 800);
    text(ctx, 'STARRING YOU', width / 2, 110, 34, 700, 'rgb(255 255 255 / 0.8)', 'center', 10);
    text(ctx, brand, width / 2, 1150, fitSize(ctx, brand, 150, 900, width - 100), 900, '#fff', 'center', -2);
    text(ctx, `IN CINEMAS ${monthYear(look.date).toUpperCase()}`, width / 2, 1215, 30, 700, look.accent, 'center', 8);
    text(ctx, 'A PHOTOBOOTH PRODUCTION · DIRECTED BY THE CAMERA · MUSIC BY THE CROWD', width / 2, 1290, 18, 600, 'rgb(255 255 255 / 0.5)', 'center', 2);
  } else if (preset.layout === 'pass') {
    ctx.fillStyle = '#e9e7e4';
    ctx.fillRect(0, 0, width, height);
    const card = { x: 110, y: 120, w: 860, h: 1110 };
    ctx.save();
    ctx.shadowColor = 'rgb(0 0 0 / 0.2)';
    ctx.shadowBlur = 40;
    ctx.shadowOffsetY = 14;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.roundRect(card.x, card.y, card.w, card.h, 40);
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(card.x, card.y, card.w, 220, [40, 40, 0, 0]);
    ctx.fillStyle = look.accent;
    ctx.fill();
    ctx.restore();
    text(ctx, 'VIP PASS', card.x + 60, card.y + 135, 84, 900, '#fff', 'left', 4);
    text(ctx, brand, card.x + 60, card.y + 185, 30, 700, 'rgb(255 255 255 / 0.85)', 'left', 4);
    rounded(ctx, first, card.x + 60, card.y + 280, 400, 500, 28);
    text(ctx, 'GUEST', card.x + 500, card.y + 340, 30, 700, '#888', 'left', 4);
    text(ctx, 'All access', card.x + 500, card.y + 400, 52, 800, '#111');
    text(ctx, 'DATE', card.x + 500, card.y + 500, 30, 700, '#888', 'left', 4);
    text(ctx, longDate(look.date), card.x + 500, card.y + 550, 38, 700, '#111');
    text(ctx, 'ZONE', card.x + 500, card.y + 650, 30, 700, '#888', 'left', 4);
    text(ctx, 'Backstage', card.x + 500, card.y + 700, 38, 700, '#111');
    // A decorative barcode, drawn from the brand name so each brand gets its own pattern.
    let x = card.x + 60;
    const seed = [...brand].map((c) => c.charCodeAt(0));
    for (let i = 0; x < card.x + card.w - 60; i++) {
      const bar = 3 + (seed[i % seed.length] % 4) * 3;
      ctx.fillStyle = '#111';
      ctx.fillRect(x, card.y + 880, bar, 150);
      x += bar + 6 + ((seed[(i + 1) % seed.length] >> 2) % 3) * 3;
    }
  } else if (preset.layout === 'squad') {
    ctx.fillStyle = look.ink;
    ctx.fillRect(0, 0, width, height);
    const shown = faces.slice(0, 4);
    const cols = shown.length === 1 ? 1 : 2;
    const rows = Math.ceil(shown.length / cols);
    const gap = 30;
    const top = 220;
    const cellW = (width - 120 - gap * (cols - 1)) / cols;
    const cellH = (height - top - 90 - gap * (rows - 1)) / rows;
    shown.forEach((face, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      // An odd face out on the last row sits in the middle.
      const lastAlone = shown.length % 2 === 1 && index === shown.length - 1 && cols === 2;
      const x = lastAlone ? (width - cellW) / 2 : 60 + col * (cellW + gap);
      rounded(ctx, face, x, top + row * (cellH + gap), cellW, cellH, 30);
    });
    text(ctx, shown.length > 1 ? 'The squad' : 'Main character', 60, 130, 96, 900, '#fff');
    text(ctx, `${brand} · ${longDate(look.date)}`, 60, 185, 30, 600, look.accent, 'left', 3);
  } else {
    const chosen = look.frame;
    if (!chosen) throw new Error('This preset needs a frame. Pick one on the Frames page.');
    const { frame, image } = chosen;
    const filled = composeFrame(image, frame.width, frame.height, frame.slots, faces as CanvasImageSource[]);
    // The frame keeps its own shape, centred on the 4:5 page.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    const scale = Math.min(width / frame.width, height / frame.height);
    ctx.drawImage(filled, (width - frame.width * scale) / 2, (height - frame.height * scale) / 2, frame.width * scale, frame.height * scale);
  }
  return canvas;
}

/**
 * The template to suggest first: a group layout when several faces are chosen, otherwise the first
 * active one.
 */
export function suggestPreset(presets: readonly Preset[], faceCount: number): Preset | null {
  const active = presets.filter((entry) => entry.active);
  return (faceCount > 1 ? active.find((entry) => entry.layout === 'squad') : null) ?? active.find((entry) => entry.layout !== 'squad') ?? active[0] ?? null;
}
