import { openSource, type CameraSource, type OpenedSource } from './camera-source';

export type CameraError = 'insecure' | 'denied' | 'not-found' | 'in-use' | 'unknown';

/** Opens the source and plays it in the video element, which every tracker and capture reads. */
export async function startCamera(video: HTMLVideoElement, source: CameraSource): Promise<OpenedSource> {
  const opened = await openSource(source);
  video.srcObject = opened.stream;
  await new Promise<void>((resolve) => {
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) resolve();
    else video.addEventListener('loadedmetadata', () => resolve(), { once: true });
  });
  await video.play();
  return opened;
}

export function classifyCameraError(e: unknown): CameraError {
  const name = e instanceof DOMException ? e.name : '';
  switch (name) {
    case 'SecurityError':
      return 'insecure';
    case 'NotAllowedError':
      return 'denied';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'not-found';
    case 'NotReadableError':
    case 'AbortError':
      return 'in-use';
    default:
      return 'unknown';
  }
}

export const CAMERA_MESSAGES: Record<CameraError, string> = {
  insecure: 'The camera needs HTTPS or localhost.',
  denied: 'Camera permission denied. Allow it in the address bar and reload.',
  'not-found': 'No camera found on this device.',
  'in-use': 'The camera is in use by another app.',
  unknown: 'Could not start the camera.',
};
