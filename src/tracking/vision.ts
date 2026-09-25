import { FilesetResolver } from '@mediapipe/tasks-vision';

type VisionFileset = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;

const WASM_BASE = '/wasm';

export const MODEL_URLS = {
  face: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  pose: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
} as const;

let fileset: Promise<VisionFileset> | null = null;

export function getVisionFileset(): Promise<VisionFileset> {
  fileset ??= FilesetResolver.forVisionTasks(WASM_BASE);
  return fileset;
}

let lastTimestamp = 0;

/** MediaPipe rejects frames whose timestamp does not increase. */
export function nextTimestamp(): number {
  const now = performance.now();
  lastTimestamp = now > lastTimestamp ? now : lastTimestamp + 1;
  return lastTimestamp;
}

/** Creates a landmarker on the GPU, falling back to CPU when the GPU delegate fails. */
export async function createWithFallback<T>(
  create: (delegate: 'GPU' | 'CPU') => Promise<T>,
): Promise<T> {
  try {
    return await create('GPU');
  } catch (gpuError) {
    console.warn('GPU delegate failed, retrying on CPU', gpuError);
    return create('CPU');
  }
}
