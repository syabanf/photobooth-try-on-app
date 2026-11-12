import { FilesetResolver } from '@mediapipe/tasks-vision';

type VisionFileset = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;

const WASM_BASE = '/wasm';

/** Where Google hosts each model; `pnpm models` copies them into public/models for offline booths. */
export const MODEL_SOURCES = {
  face: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  pose: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  gesture: 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task',
  segmenter: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite',
} as const;

export type ModelName = keyof typeof MODEL_SOURCES;

const resolved = new Map<ModelName, Promise<string>>();

/**
 * The model's address on this server when the booth has a local copy, Google's otherwise. A dev
 * server answers a missing file with index.html, so an HTML reply counts as missing.
 */
export function modelUrl(name: ModelName): Promise<string> {
  let url = resolved.get(name);
  if (!url) {
    const local = `/models/${MODEL_SOURCES[name].split('/').pop()}`;
    url = fetch(local, { method: 'HEAD' })
      .then((response) => (response.ok && !response.headers.get('content-type')?.includes('text/html') ? local : MODEL_SOURCES[name]))
      .catch(() => MODEL_SOURCES[name]);
    resolved.set(name, url);
  }
  return url;
}

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
