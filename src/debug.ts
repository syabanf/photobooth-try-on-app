import { FACE, type LandmarkLike } from './anchors';
import { POSE } from './garment';

export const DEBUG = new URLSearchParams(location.search).has('debug');

const FACE_POINTS = Object.values(FACE);
const POSE_POINTS = Object.values(POSE);

/** Draws the landmark indices the anchors depend on, so their placement can be checked by eye. */
export function drawLandmarkDots(
  ctx: CanvasRenderingContext2D,
  lm: readonly LandmarkLike[],
  width: number,
  height: number,
): void {
  const indices = lm.length > 100 ? FACE_POINTS : POSE_POINTS;
  ctx.save();
  ctx.fillStyle = '#00e5ff';
  ctx.strokeStyle = '#000';
  ctx.font = '12px monospace';
  ctx.textBaseline = 'middle';
  for (const i of indices) {
    const x = lm[i].x * width;
    const y = lm[i].y * height;
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeText(String(i), x + 6, y);
    ctx.fillText(String(i), x + 6, y);
  }
  ctx.restore();
}
