// Camera setup for one booth: pick how the camera connects, type a DSLR's IP address, test it,
// and choose what the booth uses it for. A webcam or IP stream hands over to the camera picker.

import { describeSource, readSource, writeSource } from '../camera-source';
import { openDialog } from '../dialogs';
import { el } from '../dom';
import { icon } from '../icons';
import type { DslrFeatures, DslrProtocol, DslrSetup } from '../ops/model';
import type { Ops } from '../ops/ops';
import { checkLink, DEFAULT_PORTS, dslrClient, PROTOCOL_LABELS, type DslrInfo } from './protocol';

type Choice = DslrProtocol | 'browser' | 'simulator';

const CHOICES: { value: Choice; title: string; meta: string }[] = [
  { value: 'ccapi', title: 'Canon over Wi-Fi or LAN', meta: 'CCAPI, by the camera’s IP address' },
  { value: 'digicam', title: 'DSLR over USB', meta: 'Canon or Nikon through digiCamControl on a PC' },
  { value: 'browser', title: 'Webcam or IP stream', meta: 'USB webcam, built-in camera, MJPEG or HLS link' },
  { value: 'simulator', title: 'Simulator', meta: 'No camera: try profiles, battery and alerts' },
];

const FEATURES: { key: keyof DslrFeatures; title: string; detail: string }[] = [
  { key: 'liveView', title: 'Live view as the booth preview', detail: 'Customers frame themselves on the camera’s own picture.' },
  { key: 'capture', title: 'Shoot photos with the DSLR', detail: 'Strips and singles come from the camera at full resolution. GIF and video still record the preview.' },
  { key: 'settings', title: 'Send preview and capture profiles', detail: 'ISO, aperture, shutter, white balance and picture style from this booth’s profiles.' },
  { key: 'autofocus', title: 'Focus before each shot', detail: 'Adds a moment per shot; turn it off with manual focus.' },
  { key: 'battery', title: 'Watch the battery', detail: 'The level shows on Devices and an alert fires when it runs low.' },
];

const PROTOCOL_HINTS: Record<DslrProtocol, string> = {
  ccapi: 'Activate CCAPI once with Canon’s free tool, connect the camera to the venue Wi-Fi or LAN, then read its IP address in the camera’s network menu. CCAPI listens on port 8080.',
  digicam: 'Install digiCamControl on the PC the camera is plugged into, turn on its web server (Settings → Webserver), and type that PC’s IP address. The web server listens on port 5513.',
};

export function cameraSetupDialog(ops: Ops, boothId: string, onSaved: () => void): void {
  const profile = ops.cameraProfile(boothId);
  const thisDevice = boothId === ops.hooks.devicePointId();
  let choice: Choice = profile.driver === 'dslr' && profile.dslr ? profile.dslr.link.protocol : profile.driver === 'edsdk' ? 'simulator' : 'browser';
  let tested: DslrInfo | null = profile.dslr ? { model: profile.dslr.model, battery: null, supports: FEATURES.map((feature) => feature.key) } : null;
  const features: DslrFeatures = profile.dslr?.features ?? { liveView: true, capture: true, settings: true, autofocus: true, battery: true };
  let preview = '';

  const body = el('div', 'form-stack camera-setup');
  const save = el('button', 'btn btn-primary', 'Save');
  save.type = 'button';
  const cancel = el('button', 'btn btn-outline', 'Cancel');
  cancel.type = 'button';
  cancel.dataset.close = '';

  const host = el('input', 'input');
  host.inputMode = 'decimal';
  host.autocomplete = 'off';
  host.placeholder = '192.168.1.20';
  host.value = profile.dslr?.link.host ?? '';
  const port = el('input', 'input camera-setup-port');
  port.inputMode = 'numeric';
  port.value = String(profile.dslr?.link.port ?? DEFAULT_PORTS.ccapi);
  const result = el('div', 'camera-setup-result');
  const error = el('p', 'field-error');
  error.hidden = true;

  const protocol = () => choice as DslrProtocol;
  const isDslr = () => choice === 'ccapi' || choice === 'digicam';
  const link = () => ({ protocol: protocol(), host: checkLink(host.value, Number(port.value)), port: Number(port.value) });

  // A changed address or protocol needs a fresh test before Save.
  const untest = () => {
    tested = null;
    if (preview) URL.revokeObjectURL(preview);
    preview = '';
    draw();
  };
  host.addEventListener('input', untest);
  port.addEventListener('input', untest);

  async function test(button: HTMLButtonElement): Promise<void> {
    error.hidden = true;
    button.disabled = true;
    button.textContent = 'Testing…';
    try {
      const client = dslrClient(link());
      tested = await client.info();
      try {
        await client.startLiveView();
        if (preview) URL.revokeObjectURL(preview);
        preview = URL.createObjectURL(await client.liveViewFrame());
      } catch {
        // The camera answered but sent no live view: the feature turns off below.
        tested.supports = tested.supports.filter((feature) => feature !== 'liveView');
      }
      for (const { key } of FEATURES) if (!tested.supports.includes(key)) features[key] = false;
    } catch (reason) {
      tested = null;
      error.textContent = (reason as Error).message;
      error.hidden = false;
    }
    draw();
  }

  function choiceGrid(): HTMLElement {
    const grid = el('div', 'choice-grid camera-setup-choices');
    for (const option of CHOICES) {
      const button = el('button', `choice${option.value === choice ? ' is-active' : ''}`);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(option.value === choice));
      button.append(el('span', 'choice-title', option.title), el('span', 'choice-meta', option.meta));
      button.addEventListener('click', () => {
        if (choice === option.value) return;
        choice = option.value;
        if (option.value === 'ccapi' || option.value === 'digicam') port.value = String(DEFAULT_PORTS[option.value]);
        untest();
      });
      grid.append(button);
    }
    return grid;
  }

  function connectionFields(): HTMLElement {
    const row = el('div', 'camera-setup-address');
    const hostField = el('label', 'field');
    hostField.append(el('span', 'field-label', choice === 'ccapi' ? 'Camera IP address' : 'PC IP address'), host);
    const portField = el('label', 'field');
    portField.append(el('span', 'field-label', 'Port'), port);
    const testButton = el('button', 'btn btn-secondary', tested ? 'Test again' : 'Test connection');
    testButton.type = 'button';
    testButton.prepend(icon('wifi'));
    testButton.addEventListener('click', () => void test(testButton));
    row.append(hostField, portField, testButton);
    const wrap = el('div', 'form-stack');
    wrap.append(el('p', 'field-hint', PROTOCOL_HINTS[protocol()]), row, error);
    return wrap;
  }

  function testResult(): HTMLElement {
    result.replaceChildren();
    if (!tested) return result;
    if (preview) {
      const img = el('img', 'camera-setup-preview');
      img.src = preview;
      img.alt = `Live view from ${tested.model}`;
      result.append(img);
    }
    const facts = el('dl', 'facts');
    for (const [term, value] of [
      ['Camera', tested.model],
      ['Connection', `${PROTOCOL_LABELS[protocol()]} · ${host.value}:${port.value}`],
      ['Battery', tested.battery === null ? 'Not reported' : `${tested.battery}%`],
    ]) facts.append(el('dt', '', term), el('dd', '', value));
    const status = el('p', 'camera-setup-ok');
    status.append(icon('check'), el('span', '', 'Connected'));
    const text = el('div');
    text.append(status, facts);
    result.append(text);
    return result;
  }

  function featureList(): HTMLElement {
    const list = el('fieldset', 'camera-setup-features');
    list.append(el('legend', 'field-label', 'Use the camera for'));
    for (const feature of FEATURES) {
      const supported = !tested || tested.supports.includes(feature.key);
      const row = el('label', `camera-setup-feature${supported ? '' : ' is-off'}`);
      const box = el('input', 'switch');
      box.type = 'checkbox';
      box.setAttribute('role', 'switch');
      box.checked = supported && features[feature.key];
      box.disabled = !tested || !supported;
      box.addEventListener('change', () => (features[feature.key] = box.checked));
      const text = el('span', 'camera-setup-feature-text');
      text.append(el('span', 'camera-setup-feature-title', feature.title), el('span', 'field-hint', supported ? feature.detail : 'This camera or connection cannot do this.'));
      row.append(text, box);
      list.append(row);
    }
    return list;
  }

  function draw(): void {
    const parts: HTMLElement[] = [choiceGrid()];
    if (isDslr()) parts.push(connectionFields(), testResult(), featureList());
    else if (choice === 'browser') parts.push(el('p', 'field-hint', thisDevice ? `This device uses ${describeSource(readSource())}. Save opens the camera picker for a webcam, USB camera or IP stream.` : 'Pick the webcam or IP stream on the booth device itself: Devices → Cameras → Camera source.'));
    else parts.push(el('p', 'field-hint', 'The simulator keeps profiles and a battery so alerts and power-up behaviour can be tried. It takes no pictures of its own: photos come from this device’s webcam.'));
    body.replaceChildren(...parts);
    save.disabled = isDslr() && !tested;
    save.title = save.disabled ? 'Test the connection first.' : '';
  }

  save.addEventListener('click', () => {
    try {
      if (isDslr()) {
        const setup: DslrSetup = { link: link(), features: { ...features }, model: tested!.model };
        ops.saveCameraProfile({ ...profile, driver: 'dslr', dslr: setup });
        if (thisDevice) {
          if (setup.features.liveView) writeSource({ kind: 'dslr', link: setup.link, model: setup.model });
          else if (readSource().kind === 'dslr') writeSource({ kind: 'auto' });
        }
      } else {
        ops.saveCameraProfile({ ...profile, driver: choice === 'simulator' ? 'edsdk' : 'webcam', dslr: undefined });
        if (thisDevice && readSource().kind === 'dslr') writeSource({ kind: 'auto' });
      }
      handle.close();
      onSaved();
      if (thisDevice) document.dispatchEvent(new Event('vto:camera-changed'));
      if (thisDevice && choice === 'browser') document.dispatchEvent(new Event('vto:pick-camera'));
    } catch (reason) {
      error.textContent = (reason as Error).message;
      error.hidden = false;
    }
  });

  draw();
  const handle = openDialog({
    title: `Camera for ${ops.boothName(boothId)}`,
    description: 'How the camera connects, and what the booth uses it for.',
    body: [body],
    footer: [cancel, save],
  });
}
