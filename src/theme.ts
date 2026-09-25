/** Reads a colour token from the stylesheet, so canvas drawing uses the same palette as the page. */
export function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
