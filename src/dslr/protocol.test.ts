import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CAPTURE } from '../ops/adapters';
import { ccapiExposure, checkLink, dslrClient } from './protocol';

type Route = (init: RequestInit | undefined, url: URL) => Response | Promise<Response>;

/** Stands in for the booth proxy and the camera behind it, recording every call. */
function camera(routes: Record<string, Route>) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://booth');
    const path = url.pathname.replace(/^\/api\/camera\/[^/]+/, '');
    calls.push(`${init?.method ?? 'GET'} ${path}${url.search}`);
    const route = routes[`${init?.method ?? 'GET'} ${path}`];
    return route ? route(init, url) : new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
  });
  return calls;
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
const jpeg = () => new Response(new Blob(['jpeg'], { type: 'image/jpeg' }));

afterEach(() => vi.unstubAllGlobals());

describe('checkLink', () => {
  it('takes a private IPv4 and a port', () => {
    expect(checkLink(' 192.168.1.20 ', 8080)).toBe('192.168.1.20');
    expect(checkLink('10.0.0.5', 5513)).toBe('10.0.0.5');
    expect(checkLink('172.20.1.1', 80)).toBe('172.20.1.1');
  });

  it('refuses names, public addresses and bad ports', () => {
    expect(() => checkLink('camera.local', 8080)).toThrow('IP address');
    expect(() => checkLink('8.8.8.8', 8080)).toThrow('on this network');
    expect(() => checkLink('192.168.1.300', 8080)).toThrow('IP address');
    expect(() => checkLink('192.168.1.2', 70_000)).toThrow('port');
  });
});

describe('Canon CCAPI', () => {
  const link = { protocol: 'ccapi' as const, host: '192.168.1.20', port: 8080 };

  it('reads the model and battery', async () => {
    camera({
      'GET /ccapi/ver100/deviceinformation': () => ok({ manufacturer: 'Canon', productname: 'EOS R6' }),
      'GET /ccapi/ver100/devicestatus/battery': () => ok({ level: 'half' }),
    });
    expect(await dslrClient(link).info()).toMatchObject({ model: 'Canon EOS R6', battery: 50 });
  });

  it('presses the shutter and fetches the JPEG the camera adds', async () => {
    let polls = 0;
    const calls = camera({
      'GET /ccapi/ver100/event/polling': () => ok(++polls < 3 ? {} : { addedcontents: ['/ccapi/ver100/contents/sd/100CANON/IMG_0001.CR3', '/ccapi/ver100/contents/sd/100CANON/IMG_0001.JPG'] }),
      'POST /ccapi/ver100/shooting/control/shutterbutton': (init) => {
        expect(JSON.parse(String(init?.body))).toEqual({ af: true });
        return ok({});
      },
      'GET /ccapi/ver100/contents/sd/100CANON/IMG_0001.JPG': jpeg,
    });
    const photo = await dslrClient(link).shoot(true);
    expect(photo.size).toBeGreaterThan(0);
    expect(calls.at(-1)).toBe('GET /ccapi/ver100/contents/sd/100CANON/IMG_0001.JPG?kind=main');
  });

  it('sends each setting and names the ones the camera refused', async () => {
    const sent: Record<string, string> = {};
    camera(Object.fromEntries(['iso', 'av', 'tv', 'wb', 'exposure', 'picturestyle'].map((name) => [`PUT /ccapi/ver100/shooting/settings/${name}`, (init: RequestInit | undefined) => {
      sent[name] = JSON.parse(String(init?.body)).value;
      return name === 'picturestyle' ? new Response('{}', { status: 503 }) : ok({});
    }])));
    const refused = await dslrClient(link).apply({ ...DEFAULT_CAPTURE, exposureComp: -0.5 });
    expect(sent).toMatchObject({ iso: '200', av: 'f5.6', tv: '1/125', wb: 'flash', exposure: '-0_2/3' });
    expect(refused).toEqual(['picturestyle']);
  });

  it('says plainly when the camera does not answer', async () => {
    camera({ 'GET /ccapi/ver100/deviceinformation': () => new Response('{}', { status: 502 }) });
    await expect(dslrClient(link).info()).rejects.toThrow('No answer from 192.168.1.20:8080');
  });

  it('writes exposure compensation in thirds', () => {
    expect(ccapiExposure(0)).toBe('+0.0');
    expect(ccapiExposure(1)).toBe('+1.0');
    expect(ccapiExposure(1.5)).toBe('+1_2/3');
    expect(ccapiExposure(-2)).toBe('-2.0');
  });
});

describe('digiCamControl', () => {
  const link = { protocol: 'digicam' as const, host: '192.168.1.50', port: 5513 };

  it('captures and downloads the new file once it changes', async () => {
    let last = 'DSC_0001.jpg';
    let asks = 0;
    const calls = camera({
      'GET /': (_init, url) => {
        if (url.searchParams.get('slc') === 'capture') {
          last = '-';
          return ok({});
        }
        // The first check runs before the shot; then the download is in progress, then done.
        asks += 1;
        if (asks === 3) last = 'DSC_0002.jpg';
        return new Response(last);
      },
      'GET /image/DSC_0002.jpg': jpeg,
    });
    const photo = await dslrClient(link).shoot(true);
    expect(photo.size).toBeGreaterThan(0);
    expect(calls).toContain('GET /?slc=capture&param1=&param2=');
    expect(calls.at(-1)).toBe('GET /image/DSC_0002.jpg');
  });
});
