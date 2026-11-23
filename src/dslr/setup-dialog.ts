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
  { value: 'ccapi', title: 'Canon lewat Wi-Fi atau LAN', meta: 'CCAPI, lewat alamat IP kamera' },
  { value: 'digicam', title: 'DSLR lewat USB', meta: 'Canon atau Nikon lewat digiCamControl di PC' },
  { value: 'browser', title: 'Webcam atau stream IP', meta: 'Webcam USB, kamera bawaan, link MJPEG atau HLS' },
  { value: 'simulator', title: 'Simulator', meta: 'Tanpa kamera: coba profil, baterai dan peringatan' },
];

const FEATURES: { key: keyof DslrFeatures; title: string; detail: string }[] = [
  { key: 'liveView', title: 'Live view sebagai pratinjau booth', detail: 'Pelanggan mengatur posisi lewat gambar dari kamera itu sendiri.' },
  { key: 'capture', title: 'Memotret dengan DSLR', detail: 'Strip dan foto tunggal diambil dari kamera dengan resolusi penuh. GIF dan video tetap merekam pratinjau.' },
  { key: 'settings', title: 'Kirim profil pratinjau dan pemotretan', detail: 'ISO, aperture, shutter, white balance dan picture style dari profil booth ini.' },
  { key: 'autofocus', title: 'Fokus sebelum setiap foto', detail: 'Menambah jeda sesaat per foto. Matikan bila memakai fokus manual.' },
  { key: 'battery', title: 'Pantau baterai', detail: 'Level baterai tampil di Perangkat dan peringatan muncul saat hampir habis.' },
];

const PROTOCOL_HINTS: Record<DslrProtocol, string> = {
  ccapi: 'Aktifkan CCAPI sekali dengan aplikasi gratis dari Canon, sambungkan kamera ke Wi-Fi atau LAN lokasi, lalu lihat alamat IP-nya di menu jaringan kamera. CCAPI memakai port 8080.',
  digicam: 'Pasang digiCamControl di PC tempat kamera dicolok, nyalakan web server-nya (Settings → Webserver), lalu ketik alamat IP PC itu. Web server memakai port 5513.',
};

export function cameraSetupDialog(ops: Ops, boothId: string, onSaved: () => void): void {
  const profile = ops.cameraProfile(boothId);
  const thisDevice = boothId === ops.hooks.devicePointId();
  let choice: Choice = profile.driver === 'dslr' && profile.dslr ? profile.dslr.link.protocol : profile.driver === 'edsdk' ? 'simulator' : 'browser';
  let tested: DslrInfo | null = profile.dslr ? { model: profile.dslr.model, battery: null, supports: FEATURES.map((feature) => feature.key) } : null;
  const features: DslrFeatures = profile.dslr?.features ?? { liveView: true, capture: true, settings: true, autofocus: true, battery: true };
  let preview = '';

  const body = el('div', 'form-stack camera-setup');
  const save = el('button', 'btn btn-primary', 'Simpan');
  save.type = 'button';
  const cancel = el('button', 'btn btn-outline', 'Batal');
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
    button.textContent = 'Menguji…';
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
    hostField.append(el('span', 'field-label', choice === 'ccapi' ? 'Alamat IP kamera' : 'Alamat IP PC'), host);
    const portField = el('label', 'field');
    portField.append(el('span', 'field-label', 'Port'), port);
    const testButton = el('button', 'btn btn-secondary', tested ? 'Uji lagi' : 'Uji koneksi');
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
      img.alt = `Live view dari ${tested.model}`;
      result.append(img);
    }
    const facts = el('dl', 'facts');
    for (const [term, value] of [
      ['Kamera', tested.model],
      ['Koneksi', `${PROTOCOL_LABELS[protocol()]} · ${host.value}:${port.value}`],
      ['Baterai', tested.battery === null ? 'Tidak dilaporkan' : `${tested.battery}%`],
    ]) facts.append(el('dt', '', term), el('dd', '', value));
    const status = el('p', 'camera-setup-ok');
    status.append(icon('check'), el('span', '', 'Terhubung'));
    const text = el('div');
    text.append(status, facts);
    result.append(text);
    return result;
  }

  function featureList(): HTMLElement {
    const list = el('fieldset', 'camera-setup-features');
    list.append(el('legend', 'field-label', 'Pakai kamera untuk'));
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
      text.append(el('span', 'camera-setup-feature-title', feature.title), el('span', 'field-hint', supported ? feature.detail : 'Kamera atau koneksi ini tidak mendukung fitur ini.'));
      row.append(text, box);
      list.append(row);
    }
    return list;
  }

  function draw(): void {
    const parts: HTMLElement[] = [choiceGrid()];
    if (isDslr()) parts.push(connectionFields(), testResult(), featureList());
    else if (choice === 'browser') parts.push(el('p', 'field-hint', thisDevice ? `Perangkat ini memakai ${describeSource(readSource())}. Simpan membuka pemilih kamera untuk webcam, kamera USB atau stream IP.` : 'Pilih webcam atau stream IP di perangkat booth itu sendiri: Perangkat → Kamera → Sumber kamera.'));
    else parts.push(el('p', 'field-hint', 'Simulator menyimpan profil dan baterai tiruan agar peringatan dan perilaku saat menyala bisa dicoba. Simulator tidak memotret sendiri: foto diambil dari webcam perangkat ini.'));
    body.replaceChildren(...parts);
    save.disabled = isDslr() && !tested;
    save.title = save.disabled ? 'Uji koneksi dulu.' : '';
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
    title: `Kamera untuk ${ops.boothName(boothId)}`,
    description: 'Cara kamera tersambung, dan untuk apa booth memakainya.',
    body: [body],
    footer: [cancel, save],
  });
}
