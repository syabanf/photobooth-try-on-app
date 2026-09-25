// Live try-on through Decart's hosted model: the camera streams out, a generated video comes back.

import { createDecartClient, models, type RealTimeClient } from '@decartai/sdk';
import type { CatalogItem } from './catalog';

/** Decart's virtual try-on model. It repaints each frame with the garment worn. */
const MODEL = 'lucy-vton-latest';

const KEY_STORAGE = 'decart-api-key';

export interface SessionCallbacks {
  onRemoteStream: (stream: MediaStream) => void;
  /** Called when the session drops or the server ends it, so the page can say so. */
  onClosed: (reason: string) => void;
  onError: (message: string) => void;
}

/**
 * The key lives in session storage, so it is gone when the tab closes and never reaches disk.
 * A public deployment should mint short-lived client tokens on a server instead.
 */
export function readStoredKey(): string {
  try {
    return sessionStorage.getItem(KEY_STORAGE) ?? '';
  } catch {
    return '';
  }
}

export function storeKey(key: string): void {
  try {
    sessionStorage.setItem(KEY_STORAGE, key);
  } catch {
    // Private browsing can refuse storage; the key still works for this session.
  }
}

/** Phrasing Decart's examples recommend: name the swap, then describe the garment. */
function garmentPrompt(item: CatalogItem): string {
  return `Substitute the current top with a ${item.name.toLowerCase()}, worn naturally with a realistic fit`;
}

export async function connect(
  apiKey: string,
  stream: MediaStream,
  callbacks: SessionCallbacks,
): Promise<RealTimeClient> {
  const client = createDecartClient({ apiKey });
  const session = await client.realtime.connect(stream, {
    model: models.realtime(MODEL),
    onRemoteStream: callbacks.onRemoteStream,
    onConnectionChange: (state) => {
      if (state === 'disconnected') callbacks.onClosed('Connection dropped.');
    },
  });
  session.on('error', (e) => callbacks.onError(e.message));
  session.on('sessionEnded', () => callbacks.onClosed('Decart ended the session.'));
  return session;
}

export async function wearGarment(session: RealTimeClient, item: CatalogItem): Promise<void> {
  await session.setImage(item.src, { prompt: garmentPrompt(item), enhance: false });
}
