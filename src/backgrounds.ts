// Photobooth backdrops: scenery photos, a blur of the room, painted studio sweeps, or a photo of your own.

import { token } from './theme';

export type BackgroundKind = 'none' | 'blur' | 'paint' | 'image';

export interface Background {
  id: string;
  label: string;
  kind: BackgroundKind;
  paint?: (ctx: CanvasRenderingContext2D, width: number, height: number) => void;
  image?: HTMLImageElement;
  /** A remote photo, fetched on first use. `thumb` is the small version shown on the tile. */
  src?: string;
  thumb?: string;
}

/** Deterministic scatter, so the bokeh does not shimmer between frames. */
function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function studio(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const g = ctx.createRadialGradient(w * 0.5, h * 0.42, 0, w * 0.5, h * 0.5, Math.max(w, h) * 0.75);
  g.addColorStop(0, '#fbfafb');
  g.addColorStop(0.55, token('--surface'));
  g.addColorStop(1, '#cfcdd0');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

function coral(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, '#ffd9cc');
  g.addColorStop(0.5, token('--accent'));
  g.addColorStop(1, token('--accent-strong'));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

function night(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = token('--ink');
  ctx.fillRect(0, 0, w, h);
  const random = seeded(7);
  const accent = token('--accent');
  for (let i = 0; i < 38; i++) {
    const r = (0.015 + random() * 0.05) * w;
    ctx.globalAlpha = 0.08 + random() * 0.22;
    ctx.fillStyle = i % 4 === 0 ? accent : '#ffffff';
    ctx.beginPath();
    ctx.arc(random() * w, random() * h, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function sunset(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#2b1e4a');
  g.addColorStop(0.45, '#b8456b');
  g.addColorStop(0.75, '#f4845f');
  g.addColorStop(1, '#ffd29d');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

export const STUDIO_BACKGROUNDS: readonly Background[] = [
  { id: 'none', label: 'None', kind: 'none' },
  { id: 'blur', label: 'Blur', kind: 'blur' },
  { id: 'studio', label: 'Studio', kind: 'paint', paint: studio },
  { id: 'coral', label: 'Coral', kind: 'paint', paint: coral },
  { id: 'night', label: 'Night', kind: 'paint', paint: night },
  { id: 'sunset', label: 'Sunset', kind: 'paint', paint: sunset },
];

export const NO_BACKGROUND = STUDIO_BACKGROUNDS[0];

const COMMONS = 'https://thumb.wikimedia.org/wikipedia/commons/thumb/';

/** A Wikimedia Commons file at one of the widths Commons serves. */
function commons(path: string, width: number): string {
  return `${COMMONS}${path}/${width}px-${path.split('/').pop()}`;
}

function scenery(id: string, label: string, path: string): Background {
  return { id, label, kind: 'image', src: commons(path, 1280), thumb: commons(path, 330) };
}

/**
 * Scenery photos from Wikimedia Commons, each released as CC0 or public domain, so they need no
 * permission or credit. Commons serves them with open CORS headers, which keeps captured frames
 * exportable. File pages: commons.wikimedia.org/wiki/File:<name>.
 */
export const SCENERY: readonly Background[] = [
  scenery('beach', 'Beach', '4/4a/Serene_Tropical_Beach_with_Lush_Greenery.jpg'),
  scenery('rice', 'Rice field', 'a/ac/Nagari_tuo_pariangan_desa_terindah_di_dunia.jpg'),
  scenery('forest', 'Forest', '7/75/Forest_Away_Path.jpg'),
  scenery('lake', 'Lake', '7/75/Lake_Mountain_Landscape.jpg'),
  scenery('mountains', 'Mountains', 'f/fb/Mirror_Lake_and_the_Beartooth_Mountains_%2848290713076%29.jpg'),
  scenery('snow', 'Snow', '3/3c/Absaroka_Range_with_alpenglow_%28a11ac77b-6b0d-4416-9861-3d3e49355c01%29.jpg'),
];

const photos = new Map<string, Promise<HTMLImageElement>>();

/** Fetches a scenery photo once and keeps it on the background, so later picks are instant. */
export async function loadBackground(background: Background): Promise<Background> {
  const src = background.src;
  if (!src || background.image) return background;
  let pending = photos.get(src);
  if (!pending) {
    pending = new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.onload = () => resolve(image);
      image.onerror = () => {
        photos.delete(src);
        reject(new Error(`Could not load ${background.label}`));
      };
      image.src = src;
    });
    photos.set(src, pending);
  }
  background.image = await pending;
  return background;
}

const painted = new Map<string, HTMLCanvasElement>();

/** A painted backdrop at the requested size, drawn once and reused. */
export function paintedBackdrop(background: Background, width: number, height: number): HTMLCanvasElement {
  const key = `${background.id}:${width}x${height}`;
  let canvas = painted.get(key);
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    background.paint?.(canvas.getContext('2d')!, width, height);
    painted.set(key, canvas);
  }
  return canvas;
}

export function imageBackground(image: HTMLImageElement): Background {
  return { id: `image-${image.src}`, label: 'Yours', kind: 'image', image };
}
