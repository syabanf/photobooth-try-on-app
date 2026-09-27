// Decart's hosted models: live try-on, where the camera streams out and a generated video comes
// back, and the photobooth's AI blend, which redraws one shot at a time.

import { createDecartClient, models, type RealTimeClient } from '@decartai/sdk';
import type { CatalogItem } from './catalog';

/** Decart's virtual try-on model. It repaints each frame with the garment worn. */
const MODEL = 'lucy-vton-latest';

/** Decart's image editor, which redraws a still with a reference image as its guide. */
const BLEND_MODEL = 'lucy-image-2';

/** Decart asks for 20 to 30 words that name the change, the result, and what must stay. */
const BLEND_PROMPT =
  'Blend the person into the reference scene so they look photographed there, matching its light, ' +
  'shadows, colour and depth, with clean natural edges. Keep their face, hair, expression, pose and clothing unchanged.';

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

/**
 * Sends a photobooth shot, the person already cut onto the backdrop, and the backdrop itself as the
 * reference. Decart returns the shot redrawn so the person sits in the scene. Billed per image.
 */
export async function blendIntoScene(apiKey: string, shot: Blob, scene: Blob | null): Promise<Blob> {
  const client = createDecartClient({ apiKey });
  return client.process({
    model: models.image(BLEND_MODEL),
    prompt: BLEND_PROMPT,
    data: shot,
    // Blur has no scene picture; an empty key would fail the SDK's file conversion.
    ...(scene && { reference_image: scene }),
  });
}
