// Talks to a DSLR over the venue network. Two ways in:
//
//   ccapi    Canon Camera Control API, built into Wi-Fi and LAN Canon bodies (EOS R, 90D, M50 II
//            and others). The camera itself answers at http://<camera-ip>:8080/ccapi once CCAPI is
//            activated with Canon's free activation tool.
//   digicam  digiCamControl's web server on a Windows PC, which drives a Canon or Nikon over USB
//            and answers at http://<pc-ip>:5513.
//
// Neither sends CORS headers, so the page reaches them through the booth server's camera proxy
// (/api/camera/<host>:<port>/<path>), which forwards only to addresses on the local network.

import type { CameraSettings, DslrFeatures, DslrLink, DslrProtocol } from '../ops/model';

export interface DslrInfo {
  model: string;
  battery: number | null;
  /** The features this camera and protocol can do. */
  supports: (keyof DslrFeatures)[];
}

export interface DslrClient {
  info(): Promise<DslrInfo>;
  startLiveView(): Promise<void>;
  /** One live view frame as a JPEG. */
  liveViewFrame(): Promise<Blob>;
  /** Takes a picture and returns it at full size. */
  shoot(autofocus: boolean): Promise<Blob>;
  /** Sends a profile; returns the settings the camera refused, by name. */
  apply(settings: CameraSettings): Promise<string[]>;
  battery(): Promise<number | null>;
}

export const DEFAULT_PORTS: Record<DslrProtocol, number> = { ccapi: 8080, digicam: 5513 };
export const PROTOCOL_LABELS: Record<DslrProtocol, string> = { ccapi: 'Canon over Wi-Fi or LAN (CCAPI)', digicam: 'DSLR over USB via digiCamControl' };

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** The address must be a private IPv4 on this network, which is all the booth proxy forwards to. */
export function checkLink(host: string, port: number): DslrLink['host'] {
  const trimmed = host.trim();
  const parts = IPV4.exec(trimmed)?.slice(1).map(Number);
  if (!parts || parts.some((part) => part > 255)) throw new Error('Type the camera’s IP address, like 192.168.1.20.');
  const [a, b] = parts;
  const local = a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  if (!local) throw new Error('The camera must be on this network: an address starting 192.168, 10, 172.16 to 172.31 or 169.254.');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('The port is a number from 1 to 65535.');
  return trimmed;
}

const TIMEOUT_MS = 8_000;

async function call(link: DslrLink, path: string, init: RequestInit = {}, timeoutMs = TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`/api/camera/${link.host}:${link.port}${path}`, { ...init, signal: controller.signal, cache: 'no-store' });
    if (response.status === 502 || response.status === 504) throw new Error(`No answer from ${link.host}:${link.port}. Check that the camera is on and on this network.`);
    if (response.status === 404 && !response.headers.get('content-type')?.includes('json') && path.startsWith('/ccapi')) throw new Error('This camera does not answer CCAPI. Activate CCAPI with Canon’s tool, then turn on Wi-Fi remote control.');
    if (!response.ok) throw new Error(`${link.host} answered ${response.status} to ${path.split('?')[0]}.`);
    return response;
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw new Error(`${link.host}:${link.port} did not answer in ${timeoutMs / 1000} seconds.`);
    // fetch fails outright when the booth server has no camera proxy, as on a static host.
    if (error instanceof TypeError) throw new Error('This page cannot reach the camera. Open the app from the booth server (pnpm serve or pnpm dev).');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- Canon CCAPI ----------

const CCAPI = '/ccapi/ver100';
const BATTERY_LEVELS: Record<string, number> = { full: 100, high: 75, half: 50, quarter: 25, low: 10 };
const WB: Record<CameraSettings['whiteBalance'], string> = { auto: 'auto', daylight: 'daylight', cloudy: 'cloudy', tungsten: 'tungsten', fluorescent: 'whitefluorescent', flash: 'flash' };

/** CCAPI writes exposure compensation in thirds: +1, +1_1/3, -0_2/3. */
export function ccapiExposure(ev: number): string {
  const sign = ev < 0 ? '-' : '+';
  const thirds = Math.round(Math.abs(ev) * 3);
  const whole = Math.floor(thirds / 3);
  const rest = thirds % 3;
  return rest ? `${sign}${whole}_${rest}/3` : `${sign}${whole}.0`;
}

export function ccapiClient(link: DslrLink): DslrClient {
  const battery = async () => {
    const body = (await (await call(link, `${CCAPI}/devicestatus/battery`)).json()) as { level?: string };
    return BATTERY_LEVELS[body.level ?? ''] ?? null;
  };
  return {
    async info() {
      const device = (await (await call(link, `${CCAPI}/deviceinformation`)).json()) as { productname?: string; manufacturer?: string };
      return {
        model: [device.manufacturer, device.productname].filter(Boolean).join(' ') || 'Canon camera',
        battery: await battery().catch(() => null),
        supports: ['liveView', 'capture', 'settings', 'autofocus', 'battery'],
      };
    },
    async startLiveView() {
      await call(link, `${CCAPI}/shooting/liveview`, { method: 'POST', ...json({ liveviewsize: 'medium', cameradisplay: 'off' }) });
    },
    async liveViewFrame() {
      return (await call(link, `${CCAPI}/shooting/liveview/flip`)).blob();
    },
    async shoot(autofocus) {
      // Drain old events, press the shutter, then wait for the file the camera adds.
      await call(link, `${CCAPI}/event/polling?timeout=immediately`).catch(() => {});
      await call(link, `${CCAPI}/shooting/control/shutterbutton`, { method: 'POST', ...json({ af: autofocus }) }, 15_000);
      for (let tries = 0; tries < 20; tries++) {
        const events = (await (await call(link, `${CCAPI}/event/polling?timeout=immediately`)).json()) as { addedcontents?: string[] };
        const added = events.addedcontents?.find((path) => /\.jpe?g$/i.test(path));
        if (added) return (await call(link, `${added.replace(/^\/ccapi\/ver\d+/, CCAPI)}?kind=main`, {}, 20_000)).blob();
        await wait(500);
      }
      throw new Error('The camera took the shot but sent no JPEG. Set it to save JPEG, or JPEG with RAW.');
    },
    async apply(settings) {
      const values: [string, string][] = [
        ['iso', String(settings.iso)],
        ['av', `f${settings.aperture}`],
        ['tv', settings.shutter],
        ['wb', WB[settings.whiteBalance]],
        ['exposure', ccapiExposure(settings.exposureComp)],
        ['picturestyle', settings.pictureStyle],
      ];
      const refused: string[] = [];
      for (const [name, value] of values) {
        await call(link, `${CCAPI}/shooting/settings/${name}`, { method: 'PUT', ...json({ value }) }).catch(() => refused.push(name));
      }
      return refused;
    },
    battery,
  };
}

// ---------- digiCamControl ----------

const DIGICAM_WB: Record<CameraSettings['whiteBalance'], string> = { auto: 'Auto', daylight: 'Daylight', cloudy: 'Cloudy', tungsten: 'Tungsten', fluorescent: 'Fluorescent', flash: 'Flash' };

export function digicamClient(link: DslrLink): DslrClient {
  const command = (slc: string, param1 = '', param2 = '') => call(link, `/?slc=${slc}&param1=${encodeURIComponent(param1)}&param2=${encodeURIComponent(param2)}`);
  return {
    async info() {
      const session = (await (await call(link, '/session.json')).json().catch(() => ({}))) as { CameraName?: string; SelectedCameraDevice?: { DisplayName?: string } };
      return {
        model: session.SelectedCameraDevice?.DisplayName || session.CameraName || 'Camera on digiCamControl',
        battery: null,
        // digiCamControl's web server does not report the battery.
        supports: ['liveView', 'capture', 'settings', 'autofocus'],
      };
    },
    async startLiveView() {
      await call(link, '/?CMD=LiveViewWnd_Show');
    },
    async liveViewFrame() {
      return (await call(link, `/liveview.jpg?t=${Date.now()}`)).blob();
    },
    async shoot(autofocus) {
      const before = (await (await command('get', 'lastcaptured')).text()).trim();
      await command(autofocus ? 'capture' : 'capturenoaf');
      for (let tries = 0; tries < 30; tries++) {
        await wait(500);
        const last = (await (await command('get', 'lastcaptured')).text()).trim();
        // digiCamControl answers "-" while it still downloads the file from the camera.
        if (last && last !== before && last !== '-') return (await call(link, `/image/${encodeURIComponent(last)}`, {}, 20_000)).blob();
      }
      throw new Error('digiCamControl did not report the new photo. Check its session folder and that the camera saves JPEG.');
    },
    async apply(settings) {
      const values: [string, string][] = [
        ['iso', String(settings.iso)],
        ['aperture', String(settings.aperture)],
        ['shutterspeed', settings.shutter],
        ['whitebalance', DIGICAM_WB[settings.whiteBalance]],
        ['exposurecompensation', `${settings.exposureComp > 0 ? '+' : ''}${settings.exposureComp}`],
      ];
      const refused: string[] = [];
      for (const [name, value] of values) await command('set', name, value).catch(() => refused.push(name));
      return refused;
    },
    async battery() {
      return null;
    },
  };
}

export function dslrClient(link: DslrLink): DslrClient {
  return link.protocol === 'ccapi' ? ccapiClient(link) : digicamClient(link);
}
