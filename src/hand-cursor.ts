// Drives an on-screen cursor from the hand: the pinch point moves it, a pinch clicks, and a pinch
// held while moving drags (stickers, for one).

import type { Vec } from './mls';

export interface HandPoint {
  x: number;
  y: number;
}

const HAND = { WRIST: 0, THUMB_TIP: 4, INDEX_TIP: 8, MIDDLE_MCP: 9 } as const;

/**
 * The part of the camera frame that maps onto the whole screen, as shares of its width and height.
 * A comfortable arm movement then reaches every corner without stretching to the frame edge.
 */
export const REACH = { left: 0.15, right: 0.85, top: 0.12, bottom: 0.72 } as const;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * Where a camera point lands on screen. The stage shows the camera mirrored, so x flips, which
 * makes the cursor follow the hand the way a mirror would.
 */
export function toScreen(point: HandPoint, width: number, height: number, reach = REACH): Vec {
  const x = (1 - point.x - reach.left) / (reach.right - reach.left);
  const y = (point.y - reach.top) / (reach.bottom - reach.top);
  return { x: clamp01(x) * width, y: clamp01(y) * height };
}

/**
 * The point between thumb tip and index tip. Pointing with the fingertip alone makes the cursor jump
 * as the finger closes for a pinch; the midpoint barely moves while the two tips meet.
 */
export function pinchPoint(hand: readonly HandPoint[]): HandPoint {
  const a = hand[HAND.THUMB_TIP];
  const b = hand[HAND.INDEX_TIP];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Thumb-to-index gap over hand size, so a pinch reads the same near the camera or far from it. */
export function pinchRatio(hand: readonly HandPoint[], aspect: number): number {
  const distance = (a: HandPoint, b: HandPoint) => Math.hypot((b.x - a.x) * aspect, b.y - a.y);
  const size = distance(hand[HAND.WRIST], hand[HAND.MIDDLE_MCP]) || 1;
  return distance(hand[HAND.THUMB_TIP], hand[HAND.INDEX_TIP]) / size;
}

/** Closes below one ratio and opens above a higher one, so a pinch near the line does not flicker. */
export class PinchDetector {
  pinched = false;

  constructor(
    private readonly close = 0.3,
    private readonly open = 0.45,
  ) {}

  update(ratio: number): boolean {
    if (this.pinched ? ratio > this.open : ratio < this.close) this.pinched = !this.pinched;
    return this.pinched;
  }
}

/** Screen-space smoothing: steady when the hand is still, still quick across the screen. */
export function smoothPoint(previous: Vec | null, next: Vec, alpha: number): Vec {
  if (!previous) return next;
  return { x: previous.x + alpha * (next.x - previous.x), y: previous.y + alpha * (next.y - previous.y) };
}

const SMOOTHING = 0.4;
/** A press that moves less than this is a click; more is a drag. */
const CLICK_SLOP = 24;
/** How long the hand may drop out of view before an ongoing pinch is let go. */
const LOST_AFTER_MS = 400;
const POINTER_ID = 7;
const TARGETS = 'button, label, input, .sticker';

export class HandCursor {
  private readonly el: HTMLElement;
  private readonly pinch = new PinchDetector();
  private enabled = false;
  private position: Vec | null = null;
  private lastSeen = 0;
  private hovered: HTMLElement | null = null;
  private pressed: { target: Element; at: Vec } | null = null;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'hand-cursor';
    this.el.hidden = true;
    document.body.append(this.el);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.el.hidden = !enabled;
    if (!enabled) {
      this.release(false);
      this.hover(null);
      this.position = null;
    }
  }

  /** Feed one camera frame's hand, or null when no hand is in view. */
  update(hand: readonly HandPoint[] | null, aspect: number, now: number): void {
    if (!this.enabled) return;
    if (!hand) {
      if (now - this.lastSeen > LOST_AFTER_MS) {
        this.el.classList.add('is-lost');
        this.release(false);
      }
      return;
    }
    this.lastSeen = now;
    this.el.classList.remove('is-lost');

    const target = toScreen(pinchPoint(hand), innerWidth, innerHeight);
    const at = smoothPoint(this.position, target, SMOOTHING);
    this.position = at;
    this.el.style.transform = `translate(${at.x}px, ${at.y}px)`;

    const under = document.elementFromPoint(at.x, at.y);
    this.hover(under?.closest<HTMLElement>(TARGETS) ?? null);

    const wasPinched = this.pinch.pinched;
    const pinched = this.pinch.update(pinchRatio(hand, aspect));
    if (!wasPinched && pinched && under) {
      this.pressed = { target: under, at };
      this.el.classList.add('is-pressed');
      this.send(under, 'pointerdown', at);
    } else if (wasPinched && pinched && this.pressed) {
      this.send(this.pressed.target, 'pointermove', at);
    } else if (wasPinched && !pinched) {
      this.release(true);
    }
  }

  /** Ends a press; a press that barely moved also clicks what it started on. */
  private release(click: boolean): void {
    this.pinch.pinched = false;
    this.el.classList.remove('is-pressed');
    const pressed = this.pressed;
    this.pressed = null;
    if (!pressed || !this.position) return;
    this.send(pressed.target, 'pointerup', this.position);
    const travel = Math.hypot(this.position.x - pressed.at.x, this.position.y - pressed.at.y);
    if (click && travel < CLICK_SLOP) pressed.target.closest<HTMLElement>('button, label, input')?.click();
  }

  private hover(next: HTMLElement | null): void {
    if (next === this.hovered) return;
    if (this.hovered) {
      this.hovered.classList.remove('hand-hover');
      this.hovered.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }));
    }
    this.hovered = next;
    if (next) {
      next.classList.add('hand-hover');
      next.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }));
    }
  }

  private send(target: Element, type: string, at: Vec): void {
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: at.x,
        clientY: at.y,
        pointerId: POINTER_ID,
        pointerType: 'mouse',
        isPrimary: true,
      }),
    );
  }
}
