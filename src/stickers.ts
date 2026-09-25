// Photobooth stickers: dragged around on the live camera, stamped onto every shot.

import { containRect, type Rect } from './fit';
import { token } from './theme';

export interface StickerDef {
  id: string;
  kind: 'emoji' | 'badge';
  text: string;
}

export const STICKERS: readonly StickerDef[] = [
  { id: 'heart', kind: 'emoji', text: '❤️' },
  { id: 'sparkles', kind: 'emoji', text: '✨' },
  { id: 'star', kind: 'emoji', text: '⭐' },
  { id: 'fire', kind: 'emoji', text: '🔥' },
  { id: 'cool', kind: 'emoji', text: '😎' },
  { id: 'crown', kind: 'emoji', text: '👑' },
  { id: 'flower', kind: 'emoji', text: '🌸' },
  { id: 'party', kind: 'emoji', text: '🎉' },
  { id: 'kiss', kind: 'emoji', text: '💋' },
  { id: 'bow', kind: 'emoji', text: '🎀' },
  { id: 'camera', kind: 'emoji', text: '📸' },
  { id: 'butterfly', kind: 'emoji', text: '🦋' },
  { id: 'ootd', kind: 'badge', text: 'OOTD' },
  { id: 'drop', kind: 'badge', text: 'NEW DROP' },
  { id: 'fit', kind: 'badge', text: 'FIT CHECK' },
];

/** Font size as a share of the frame width, so a sticker keeps its size at any resolution. */
const DEFAULT_SIZE = { emoji: 0.1, badge: 0.04 } as const;
const MIN_SIZE = 0.025;
const MAX_SIZE = 0.3;

export interface PlacedSticker {
  key: number;
  def: StickerDef;
  /** Centre, as a share of the video frame, in the orientation the viewer sees. */
  x: number;
  y: number;
  size: number;
}

export function resizeSticker(size: number, factor: number): number {
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, size * factor));
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

const EMOJI_FONT = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';

/** Stamps stickers onto a captured frame. The frame is already in the viewer's orientation. */
export function drawStickers(canvas: HTMLCanvasElement, stickers: readonly PlacedSticker[]): void {
  const ctx = canvas.getContext('2d')!;
  const accent = token('--accent');
  for (const sticker of stickers) {
    const px = sticker.size * canvas.width;
    const cx = sticker.x * canvas.width;
    const cy = sticker.y * canvas.height;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (sticker.def.kind === 'emoji') {
      ctx.font = `${px}px ${EMOJI_FONT}`;
      ctx.fillText(sticker.def.text, cx, cy);
    } else {
      ctx.font = `800 ${px}px "DM Sans", system-ui, sans-serif`;
      const w = ctx.measureText(sticker.def.text).width + px * 1.4;
      const h = px * 1.9;
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.roundRect(cx - w / 2, cy - h / 2, w, h, h / 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(sticker.def.text, cx, cy + px * 0.05);
    }
    ctx.restore();
  }
}

/**
 * The editable sticker layer over the stage. It sits outside the mirrored stage, so stickers read
 * the right way round, and maps positions through the letterboxing of `object-fit: contain`.
 */
export class StickerLayer {
  private stickers: PlacedSticker[] = [];
  private nodes = new Map<number, HTMLElement>();
  private selected: number | null = null;
  private nextKey = 1;
  private readonly host: HTMLElement;

  constructor(
    private readonly stage: HTMLElement,
    private readonly video: () => HTMLVideoElement,
  ) {
    this.host = document.createElement('div');
    this.host.className = 'sticker-layer';
    stage.append(this.host);
    new ResizeObserver(() => this.layout()).observe(stage);
    this.host.addEventListener('pointerdown', (event) => {
      if (event.target === this.host) this.select(null);
    });
    document.addEventListener('keydown', (event) => {
      if (this.selected !== null && (event.key === 'Delete' || event.key === 'Backspace')) {
        const target = event.target as HTMLElement;
        if (target.closest('input, textarea')) return;
        this.remove(this.selected);
      }
    });
  }

  list(): readonly PlacedSticker[] {
    return this.stickers;
  }

  setVisible(visible: boolean): void {
    this.host.hidden = !visible;
    if (visible) this.layout();
  }

  add(def: StickerDef): void {
    const offset = (this.stickers.length % 5) * 0.06;
    const sticker: PlacedSticker = { key: this.nextKey++, def, x: 0.3 + offset, y: 0.25 + offset, size: DEFAULT_SIZE[def.kind] };
    this.stickers.push(sticker);
    this.host.append(this.render(sticker));
    this.select(sticker.key);
    this.layout();
  }

  clear(): void {
    this.stickers = [];
    for (const node of this.nodes.values()) node.remove();
    this.nodes.clear();
    this.selected = null;
  }

  private remove(key: number): void {
    this.stickers = this.stickers.filter((s) => s.key !== key);
    this.nodes.get(key)?.remove();
    this.nodes.delete(key);
    if (this.selected === key) this.selected = null;
  }

  private select(key: number | null): void {
    this.selected = key;
    for (const [k, node] of this.nodes) node.classList.toggle('is-selected', k === key);
  }

  private content(): Rect {
    const v = this.video();
    return containRect(this.stage.clientWidth, this.stage.clientHeight, v.videoWidth, v.videoHeight);
  }

  private layout(): void {
    const box = this.content();
    for (const sticker of this.stickers) {
      const node = this.nodes.get(sticker.key);
      if (!node) continue;
      node.style.left = `${box.x + sticker.x * box.w}px`;
      node.style.top = `${box.y + sticker.y * box.h}px`;
      node.style.fontSize = `${sticker.size * box.w}px`;
    }
  }

  private render(sticker: PlacedSticker): HTMLElement {
    const node = document.createElement('div');
    node.className = `sticker sticker--${sticker.def.kind}`;
    const face = document.createElement('span');
    face.className = 'sticker-face';
    face.textContent = sticker.def.text;

    const controls = document.createElement('div');
    controls.className = 'sticker-controls';
    const control = (label: string, text: string, run: () => void) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('aria-label', label);
      button.textContent = text;
      button.addEventListener('pointerdown', (event) => event.stopPropagation());
      button.addEventListener('click', run);
      return button;
    };
    controls.append(
      control('Smaller', '−', () => this.scale(sticker, 1 / 1.2)),
      control('Bigger', '+', () => this.scale(sticker, 1.2)),
      control('Remove', '×', () => this.remove(sticker.key)),
    );
    node.append(face, controls);

    node.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      this.select(sticker.key);
      // The hand cursor sends synthetic pointers, which the browser will not let an element capture.
      try {
        node.setPointerCapture(event.pointerId);
      } catch {
        // Moves still arrive, since the hand cursor sends them to the sticker it pressed.
      }
      const box = this.content();
      const start = { px: event.clientX, py: event.clientY, x: sticker.x, y: sticker.y };
      const move = (e: PointerEvent) => {
        sticker.x = clamp01(start.x + (e.clientX - start.px) / box.w);
        sticker.y = clamp01(start.y + (e.clientY - start.py) / box.h);
        this.layout();
      };
      const up = () => {
        node.removeEventListener('pointermove', move);
        node.removeEventListener('pointerup', up);
        node.removeEventListener('pointercancel', up);
      };
      node.addEventListener('pointermove', move);
      node.addEventListener('pointerup', up);
      node.addEventListener('pointercancel', up);
    });
    node.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        this.scale(sticker, event.deltaY < 0 ? 1.08 : 1 / 1.08);
      },
      { passive: false },
    );

    this.nodes.set(sticker.key, node);
    return node;
  }

  private scale(sticker: PlacedSticker, factor: number): void {
    sticker.size = resizeSticker(sticker.size, factor);
    this.layout();
  }
}
