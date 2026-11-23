// The camera source dialog: a USB or built-in camera by name, or an IP camera by URL.

import { checkIpUrl, describeSource, guessFormat, listCameras, readSource, writeSource, type CameraSource } from './camera-source';
import { formDialog } from './dialogs';

export async function pickCamera(onPick: (source: CameraSource) => void): Promise<void> {
  const current = readSource();
  const cameras = await listCameras();
  const value = current.kind === 'device' ? current.deviceId : current.kind;
  const dialog = formDialog({
    title: 'Kamera',
    description: 'Pilih kamera untuk perangkat ini. Kamera IP tersambung lewat link MJPEG atau HLS. DSLR disambungkan dari Perangkat → Kamera → Atur kamera.',
    submitLabel: 'Pakai kamera',
    fields: [
      {
        name: 'source',
        label: 'Sumber',
        value,
        options: [
          { value: 'auto', label: 'Kamera bawaan' },
          ...cameras.map((camera, index) => ({ value: camera.deviceId, label: camera.label || `Kamera ${index + 1}` })),
          { value: 'ip', label: 'Kamera IP (link)' },
          ...(current.kind === 'dslr' ? [{ value: 'dslr', label: `${describeSource(current)} (live view)` }] : []),
        ],
        hint: cameras.some((camera) => !camera.label) ? 'Nama kamera muncul setelah browser diberi izin kamera.' : undefined,
      },
      {
        name: 'url',
        label: 'Link kamera IP',
        value: current.kind === 'ip' ? current.url : '',
        placeholder: 'http://192.168.1.20:1984/api/stream.mjpeg?src=booth1',
        hint: 'Untuk kamera RTSP, jalankan go2rtc atau MediaMTX di sampingnya lalu tempel link MJPEG atau HLS darinya. Kamera atau bridge harus mengizinkan halaman ini (CORS).',
      },
      {
        name: 'format',
        label: 'Jenis stream',
        value: current.kind === 'ip' ? current.format : 'auto',
        options: [
          { value: 'auto', label: 'Deteksi dari link' },
          { value: 'mjpeg', label: 'MJPEG (motion JPEG)' },
          { value: 'video', label: 'Video (HLS, MP4, WebM)' },
        ],
      },
    ],
    async submit(values) {
      const choice = String(values.source);
      let source: CameraSource;
      if (choice === 'auto') source = { kind: 'auto' };
      else if (choice === 'dslr') source = current;
      else if (choice === 'ip') {
        const url = checkIpUrl(String(values.url));
        source = { kind: 'ip', url, format: values.format === 'auto' ? guessFormat(url) : (values.format as 'mjpeg' | 'video') };
      } else {
        source = { kind: 'device', deviceId: choice, label: cameras.find((camera) => camera.deviceId === choice)?.label ?? '' };
      }
      writeSource(source);
      onPick(source);
    },
  });

  // The link and stream type only matter for an IP camera.
  const ipOnly = [dialog.input('url'), dialog.input('format')].map((input) => input.closest('.field') as HTMLElement);
  const sync = () => ipOnly.forEach((field) => (field.hidden = dialog.input('source').value !== 'ip'));
  dialog.input('source').addEventListener('change', sync);
  sync();
}
