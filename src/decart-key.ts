// The Decart API key, kept in this tab's sessionStorage only. It lives apart from the SDK so a
// screen that only checks for a key (the kiosk) does not load the SDK.

const KEY_STORAGE = 'decart-api-key';

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
