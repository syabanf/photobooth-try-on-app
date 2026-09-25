import { PoseLandmarker, type NormalizedLandmark } from '@mediapipe/tasks-vision';
import { MODEL_URLS, createWithFallback, getVisionFileset } from './vision';

let instance: Promise<PoseLandmarker> | null = null;

export function getPoseLandmarker(): Promise<PoseLandmarker> {
  instance ??= createWithFallback(async (delegate) =>
    PoseLandmarker.createFromOptions(await getVisionFileset(), {
      baseOptions: { modelAssetPath: MODEL_URLS.pose, delegate },
      runningMode: 'VIDEO',
      numPoses: 1,
      outputSegmentationMasks: false,
    }),
  ).catch((e) => {
    instance = null;
    throw e;
  });
  return instance;
}

export function detectPose(
  landmarker: PoseLandmarker,
  video: HTMLVideoElement,
  timestamp: number,
): NormalizedLandmark[] | null {
  return landmarker.detectForVideo(video, timestamp).landmarks[0] ?? null;
}
