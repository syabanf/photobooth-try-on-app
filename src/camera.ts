export type CameraError = 'insecure' | 'denied' | 'not-found' | 'in-use' | 'unknown';

const PREFERRED: MediaStreamConstraints = {
  video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
  audio: false,
};

export async function startCamera(video: HTMLVideoElement): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new DOMException('Camera API unavailable', 'SecurityError');
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(PREFERRED);
  } catch (e) {
    if (classifyCameraError(e) !== 'not-found') throw e;
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  }
  video.srcObject = stream;
  await new Promise<void>((resolve) => {
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) resolve();
    else video.addEventListener('loadedmetadata', () => resolve(), { once: true });
  });
  await video.play();
  return stream;
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
