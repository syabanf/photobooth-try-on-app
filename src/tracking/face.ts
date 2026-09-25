import { FaceLandmarker, type NormalizedLandmark } from '@mediapipe/tasks-vision';
import { MODEL_URLS, createWithFallback, getVisionFileset } from './vision';

let instance: Promise<FaceLandmarker> | null = null;

export function getFaceLandmarker(): Promise<FaceLandmarker> {
  instance ??= createWithFallback(async (delegate) =>
    FaceLandmarker.createFromOptions(await getVisionFileset(), {
      baseOptions: { modelAssetPath: MODEL_URLS.face, delegate },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
    }),
  ).catch((e) => {
    instance = null;
    throw e;
  });
  return instance;
}

export function detectFace(
  landmarker: FaceLandmarker,
  video: HTMLVideoElement,
  timestamp: number,
): NormalizedLandmark[] | null {
  return landmarker.detectForVideo(video, timestamp).faceLandmarks[0] ?? null;
}
