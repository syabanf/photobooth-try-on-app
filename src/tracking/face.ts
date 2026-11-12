import { FaceLandmarker, type NormalizedLandmark } from '@mediapipe/tasks-vision';
import { createWithFallback, getVisionFileset, modelUrl, nextTimestamp } from './vision';

let instance: Promise<FaceLandmarker> | null = null;

export function getFaceLandmarker(): Promise<FaceLandmarker> {
  instance ??= createWithFallback(async (delegate) =>
    FaceLandmarker.createFromOptions(await getVisionFileset(), {
      baseOptions: { modelAssetPath: await modelUrl('face'), delegate },
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

let group: Promise<FaceLandmarker> | null = null;

/**
 * Up to six faces in the current frame: the whole party at the entrance camera, left to right.
 * A video-mode landmarker of its own, since the try-on tracker follows one face only.
 */
export async function detectFaces(video: HTMLVideoElement): Promise<NormalizedLandmark[][]> {
  group ??= createWithFallback(async (delegate) =>
    FaceLandmarker.createFromOptions(await getVisionFileset(), {
      baseOptions: { modelAssetPath: await modelUrl('face'), delegate },
      runningMode: 'VIDEO',
      numFaces: 6,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
    }),
  ).catch((e) => {
    group = null;
    throw e;
  });
  const faces = (await group).detectForVideo(video, nextTimestamp()).faceLandmarks;
  return [...faces].sort((a, b) => a[1].x - b[1].x);
}
