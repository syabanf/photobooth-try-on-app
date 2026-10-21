// Where this device's picture comes from: a USB or built-in camera picked by name, or an IP
// camera by URL. Every source ends up as a MediaStream, so try-on, recording and Decart treat an
// IP camera exactly like a webcam.
//
// Browsers cannot open RTSP. An RTSP camera goes through a small bridge such as go2rtc or
// MediaMTX, which serves it as MJPEG or as a video stream the browser plays.

export type CameraSource =
  | { kind: 'auto' }
  | { kind: 'device'; deviceId: string; label: string }
  | { kind: 'ip'; url: string; format: 'mjpeg' | 'video' };

const KEY = 'vto:camera-source';

export function readSource(): CameraSource {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as CameraSource | null;
    return saved && ['auto', 'device', 'ip'].includes(saved.kind) ? saved : { kind: 'auto' };
  } catch {
    return { kind: 'auto' };
  }
}

export function writeSource(source: CameraSource): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(source));
  } catch {
    // Kept for this visit only.
  }
}

/** HLS, MP4 and WebM links play in a video element; everything else is read as MJPEG. */
export function guessFormat(url: string): 'mjpeg' | 'video' {
  const path = url.split(/[?#]/)[0].toLowerCase();
  return /\.(m3u8|mp4|webm|mov)$/.test(path) ? 'video' : 'mjpeg';
}

export function describeSource(source: CameraSource): string {
  if (source.kind === 'device') return source.label || 'Camera';
  if (source.kind === 'ip') return `IP camera · ${new URL(source.url).host}`;
  return 'Default camera';
}

export function checkIpUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new Error('Paste the full link, starting with http:// or https://.');
  }
  if (parsed.protocol === 'rtsp:' || parsed.protocol === 'rtsps:') {
    throw new Error('Browsers cannot open RTSP. Run go2rtc or MediaMTX next to the camera and paste the MJPEG or HLS link it gives.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Use an http:// or https:// link.');
  return parsed.toString();
}

export async function listCameras(): Promise<MediaDeviceInfo[]> {
  const devices = (await navigator.mediaDevices?.enumerateDevices?.().catch(() => [])) ?? [];
  return devices.filter((device) => device.kind === 'videoinput');
}

export interface OpenedSource {
  stream: MediaStream;
  /** Stops the frame pump and drops the elements an IP source needed. */
  close(): void;
}

const FPS = 25;

/**
 * Pumps an IP camera into a canvas and streams the canvas. The camera, or the bridge in front of
 * it, must send CORS headers: without them the browser hides the pixels and nothing can capture.
 */
async function openIp(url: string, format: 'mjpeg' | 'video'): Promise<OpenedSource> {
  const media = format === 'video' ? document.createElement('video') : document.createElement('img');
  media.crossOrigin = 'anonymous';
  if (media instanceof HTMLVideoElement) {
    Object.assign(media, { muted: true, playsInline: true, loop: true, autoplay: true });
  }
  // Off screen but rendered, so the browser keeps decoding frames.
  media.style.cssText = 'position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
  document.body.append(media);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No picture from ${new URL(url).host} after 10 seconds.`)), 10_000);
    const ok = () => {
      clearTimeout(timer);
      resolve();
    };
    const fail = () => {
      clearTimeout(timer);
      reject(new Error(`Could not load ${new URL(url).host}. Check the link, and that the camera sends CORS headers.`));
    };
    if (media instanceof HTMLVideoElement) {
      media.addEventListener('loadeddata', ok, { once: true });
      media.addEventListener('error', fail, { once: true });
      media.src = url;
      void media.play().catch(() => {});
    } else {
      media.addEventListener('load', ok, { once: true });
      media.addEventListener('error', fail, { once: true });
      media.src = url;
    }
  }).catch((error) => {
    media.remove();
    throw error;
  });

  const width = media instanceof HTMLVideoElement ? media.videoWidth : media.naturalWidth;
  const height = media instanceof HTMLVideoElement ? media.videoHeight : media.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = width || 1280;
  canvas.height = height || 720;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(media, 0, 0, canvas.width, canvas.height);
  try {
    ctx.getImageData(0, 0, 1, 1);
  } catch {
    media.remove();
    throw new Error(`${new URL(url).host} does not allow this page to read its picture. Turn on CORS on the camera or the bridge (go2rtc: api origin "*").`);
  }

  // A timer, not requestAnimationFrame: the pump must keep going while the tab is in the background.
  const pump = setInterval(() => ctx.drawImage(media, 0, 0, canvas.width, canvas.height), 1000 / FPS);
  const stream = canvas.captureStream(FPS);
  return {
    stream,
    close() {
      clearInterval(pump);
      stream.getTracks().forEach((track) => track.stop());
      if (media instanceof HTMLVideoElement) media.pause();
      media.removeAttribute('src');
      media.remove();
    },
  };
}

const PREFERRED = { width: { ideal: 1280 }, height: { ideal: 720 } };

export async function openSource(source: CameraSource): Promise<OpenedSource> {
  if (source.kind === 'ip') return openIp(source.url, source.format);
  if (!navigator.mediaDevices?.getUserMedia) throw new DOMException('Camera API unavailable', 'SecurityError');
  const video: MediaTrackConstraints =
    source.kind === 'device' ? { ...PREFERRED, deviceId: { exact: source.deviceId } } : { ...PREFERRED, facingMode: 'user' };
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
  } catch (error) {
    // A camera unplugged since it was picked, or one that cannot do 720p: fall back to any camera.
    if (!(error instanceof DOMException) || !['NotFoundError', 'OverconstrainedError'].includes(error.name)) throw error;
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  }
  return { stream, close: () => stream.getTracks().forEach((track) => track.stop()) };
}
