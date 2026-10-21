// Face crops for AI presets: the box around a detected face, with room for hair and chin, cut from
// the camera picture the way the screen shows it.

import { FACE_OVAL, type LandmarkLike } from './anchors';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Portrait crops: 4 wide by 5 tall, like a headshot. */
export const FACE_ASPECT = 4 / 5;

/**
 * The headshot box in camera pixels: the face outline grown to take in hair, ears and a little
 * neck, shaped 4:5, and kept inside the picture.
 */
export function faceBox(landmarks: readonly LandmarkLike[], width: number, height: number): Box {
  const xs = FACE_OVAL.map((index) => landmarks[index].x * width);
  const ys = FACE_OVAL.map((index) => landmarks[index].y * height);
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  const faceWidth = right - left;
  const faceHeight = bottom - top;

  // Centre a little above the face's middle, so hair fits above and the chin keeps some neck.
  const cx = (left + right) / 2;
  const cy = top + faceHeight * 0.42;
  let boxHeight = Math.max(faceHeight * 1.9, (faceWidth * 1.75) / FACE_ASPECT);
  let boxWidth = boxHeight * FACE_ASPECT;
  // A face near the edge, or very close to the lens, gets a smaller box rather than a stretched one.
  const fit = Math.min(1, width / boxWidth, height / boxHeight);
  boxWidth *= fit;
  boxHeight *= fit;
  const x = Math.min(Math.max(0, cx - boxWidth / 2), width - boxWidth);
  const y = Math.min(Math.max(0, cy - boxHeight / 2), height - boxHeight);
  return { x, y, width: boxWidth, height: boxHeight };
}

/** Cuts the headshot out of the camera picture at `size` pixels tall, mirrored like the screen. */
export function cropFace(video: HTMLVideoElement, landmarks: readonly LandmarkLike[], size = 640): HTMLCanvasElement {
  const width = video.videoWidth;
  const height = video.videoHeight;
  const box = faceBox(landmarks, width, height);
  const canvas = document.createElement('canvas');
  canvas.height = size;
  canvas.width = Math.round(size * FACE_ASPECT);
  const ctx = canvas.getContext('2d')!;
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, box.x, box.y, box.width, box.height, 0, 0, canvas.width, canvas.height);
  return canvas;
}
