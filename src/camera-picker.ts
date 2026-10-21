// The camera source dialog: a USB or built-in camera by name, or an IP camera by URL.

import { checkIpUrl, guessFormat, listCameras, readSource, writeSource, type CameraSource } from './camera-source';
import { formDialog } from './dialogs';

export async function pickCamera(onPick: (source: CameraSource) => void): Promise<void> {
  const current = readSource();
  const cameras = await listCameras();
  const value = current.kind === 'device' ? current.deviceId : current.kind;
  const dialog = formDialog({
    title: 'Camera',
    description: 'Pick the camera this device uses. An IP camera works through its MJPEG or HLS link.',
    submitLabel: 'Use camera',
    fields: [
      {
        name: 'source',
        label: 'Source',
        value,
        options: [
          { value: 'auto', label: 'Default camera' },
          ...cameras.map((camera, index) => ({ value: camera.deviceId, label: camera.label || `Camera ${index + 1}` })),
          { value: 'ip', label: 'IP camera (link)' },
        ],
        hint: cameras.some((camera) => !camera.label) ? 'Camera names appear once the browser has camera permission.' : undefined,
      },
      {
        name: 'url',
        label: 'IP camera link',
        value: current.kind === 'ip' ? current.url : '',
        placeholder: 'http://192.168.1.20:1984/api/stream.mjpeg?src=booth1',
        hint: 'For an RTSP camera, run go2rtc or MediaMTX beside it and paste the MJPEG or HLS link it serves. The camera or bridge must allow this page (CORS).',
      },
      {
        name: 'format',
        label: 'Stream type',
        value: current.kind === 'ip' ? current.format : 'auto',
        options: [
          { value: 'auto', label: 'Detect from the link' },
          { value: 'mjpeg', label: 'MJPEG (motion JPEG)' },
          { value: 'video', label: 'Video (HLS, MP4, WebM)' },
        ],
      },
    ],
    async submit(values) {
      const choice = String(values.source);
      let source: CameraSource;
      if (choice === 'auto') source = { kind: 'auto' };
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
