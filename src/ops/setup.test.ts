import { describe, expect, it } from 'vitest';
import { memoryStore } from '../account/backend';
import type { Sites } from '../account/model';
import { setupProgress, setupSteps } from './setup';
import { OpsStore } from './store';

const sites: Sites = {
  locations: [{ id: 'mall', name: 'Lembang', city: 'Bandung', address: '', createdAt: 0 }],
  points: [
    { id: 'b1', locationId: 'mall', name: 'Booth 1', code: 'B1', active: true, createdAt: 0 },
    { id: 'b2', locationId: 'mall', name: 'Booth 2', code: 'B2', active: true, createdAt: 0 },
    { id: 'old', locationId: 'mall', name: 'Retired', code: 'B9', active: false, createdAt: 0 },
  ],
};

const fresh = () => new OpsStore(memoryStore(), 'acc', 'Dusun Bambu').state;
const step = (steps: ReturnType<typeof setupSteps>, id: string) => steps.find((entry) => entry.id === id)!;

describe('setupSteps', () => {
  it('starts with nothing done on a new workspace', () => {
    const steps = setupSteps(fresh(), { locations: [], points: [] }, null);
    expect(setupProgress(steps)).toMatchObject({ done: 0, ready: false });
    expect(step(steps, 'camera').missing).toBe('Add a booth first');
  });

  it('names the booths each step still needs, and ignores retired ones', () => {
    const state = fresh();
    state.booths.push({ pointId: 'b1', categoryId: 'photobox', timeZone: 'Asia/Jakarta', modes: ['strip'] });
    state.cameras.push({ boothId: 'b1', driver: 'webcam', preview: { iso: 400, aperture: 4, shutter: '1/60', whiteBalance: 'auto', exposureComp: 0, pictureStyle: 'standard' }, capture: { iso: 200, aperture: 5.6, shutter: '1/125', whiteBalance: 'flash', exposureComp: 0, pictureStyle: 'portrait' }, secondaryDeviceId: '' });
    const steps = setupSteps(state, sites, 'b1');
    expect(step(steps, 'locations').done).toBe(true);
    expect(step(steps, 'device').done).toBe(true);
    expect(step(steps, 'prices')).toMatchObject({ done: false, missing: 'Not confirmed yet: Booth 2' });
    expect(step(steps, 'camera')).toMatchObject({ done: false, missing: 'Not set up: Booth 2' });
    expect(step(steps, 'printer').missing).toBe('No printer: Booth 1, Booth 2');
  });

  it('is ready once every required step is done, with optional ones left', () => {
    const state = fresh();
    for (const id of ['b1', 'b2']) {
      state.booths.push({ pointId: id, categoryId: 'photobox', timeZone: 'Asia/Jakarta', modes: ['strip'] });
      state.cameras.push({ boothId: id, driver: 'webcam', preview: state.cameras[0]?.preview ?? { iso: 400, aperture: 4, shutter: '1/60', whiteBalance: 'auto', exposureComp: 0, pictureStyle: 'standard' }, capture: { iso: 200, aperture: 5.6, shutter: '1/125', whiteBalance: 'flash', exposureComp: 0, pictureStyle: 'portrait' }, secondaryDeviceId: '' });
    }
    state.printers.push({ id: 'p1', name: 'DNP', brand: 'dnp', boothIds: ['b1', 'b2'], sizes: ['4R'], paperLeft: 400, lowThreshold: 50, status: 'ok', error: '' });
    state.settings.payments.gateway = { ...state.settings.payments.gateway, merchantId: 'M123', clientKey: 'SB-Mid-client-x' };
    const progress = setupProgress(setupSteps(state, sites, null));
    expect(progress.ready).toBe(true);
    expect(progress.done).toBe(5);
  });
});
