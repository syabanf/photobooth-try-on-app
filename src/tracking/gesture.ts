import { GestureRecognizer, type NormalizedLandmark } from '@mediapipe/tasks-vision';
import { createWithFallback, getVisionFileset, modelUrl } from './vision';

const MIN_SCORE = 0.6;

let instance: Promise<GestureRecognizer> | null = null;

export function getGestureRecognizer(): Promise<GestureRecognizer> {
  instance ??= createWithFallback(async (delegate) =>
    GestureRecognizer.createFromOptions(await getVisionFileset(), {
      baseOptions: { modelAssetPath: await modelUrl('gesture'), delegate },
      runningMode: 'VIDEO',
      numHands: 1,
    }),
  ).catch((e) => {
    instance = null;
    throw e;
  });
  return instance;
}

export interface HandReading {
  /** The confident gesture on the first hand, such as "Victory", or null. */
  gesture: string | null;
  /** The first hand's 21 landmarks, which also drive the hand cursor, or null with no hand in view. */
  hand: NormalizedLandmark[] | null;
}

export const NO_HAND: HandReading = { gesture: null, hand: null };

export function readHand(recognizer: GestureRecognizer, video: HTMLVideoElement, timestamp: number): HandReading {
  const result = recognizer.recognizeForVideo(video, timestamp);
  const top = result.gestures[0]?.[0];
  const confident = top && top.score >= MIN_SCORE && top.categoryName !== 'None';
  return { gesture: confident ? top.categoryName : null, hand: result.landmarks[0] ?? null };
}
