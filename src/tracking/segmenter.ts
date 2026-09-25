import { ImageSegmenter } from '@mediapipe/tasks-vision';
import { createWithFallback, getVisionFileset } from './vision';

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite';

/** Class indices the selfie multiclass model assigns to each pixel. */
export const SEGMENT = {
  BACKGROUND: 0,
  HAIR: 1,
  BODY_SKIN: 2,
  FACE_SKIN: 3,
  CLOTHES: 4,
  ACCESSORIES: 5,
} as const;

export interface SegmentMask {
  data: Uint8Array;
  width: number;
  height: number;
}

/**
 * Width the frame is shrunk to before segmenting. The mask comes back at the size it went in, and
 * reading it off the GPU costs time in proportion to its area: a full camera frame took 47 ms,
 * while this size takes a few. An occlusion edge does not need more detail than this.
 */
const INPUT_WIDTH = 256;

let instance: Promise<ImageSegmenter> | null = null;

export function getSegmenter(): Promise<ImageSegmenter> {
  instance ??= createWithFallback(async (delegate) =>
    ImageSegmenter.createFromOptions(await getVisionFileset(), {
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: 'VIDEO',
      outputCategoryMask: true,
      outputConfidenceMasks: false,
    }),
  ).catch((e) => {
    instance = null;
    throw e;
  });
  return instance;
}

let buffer: SegmentMask | null = null;
let input: HTMLCanvasElement | null = null;

function downscale(video: HTMLVideoElement): HTMLCanvasElement {
  const height = Math.max(1, Math.round((INPUT_WIDTH * video.videoHeight) / video.videoWidth));
  input ??= document.createElement('canvas');
  if (input.width !== INPUT_WIDTH || input.height !== height) {
    input.width = INPUT_WIDTH;
    input.height = height;
  }
  input.getContext('2d')!.drawImage(video, 0, 0, INPUT_WIDTH, height);
  return input;
}

/**
 * One class index per pixel. The mask borrows memory that the next call reuses, so the bytes are
 * copied into a buffer of our own before the result is closed.
 */
export function segmentForVideo(
  segmenter: ImageSegmenter,
  video: HTMLVideoElement,
  timestamp: number,
): SegmentMask | null {
  const result = segmenter.segmentForVideo(downscale(video), timestamp);
  const mask = result.categoryMask;
  if (!mask) {
    result.close();
    return null;
  }
  if (!buffer || buffer.width !== mask.width || buffer.height !== mask.height) {
    buffer = { data: new Uint8Array(mask.width * mask.height), width: mask.width, height: mask.height };
  }
  buffer.data.set(mask.getAsUint8Array());
  result.close();
  return buffer;
}
