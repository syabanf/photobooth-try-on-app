// Copies the MediaPipe models into public/models, so a booth loads them from its own server and
// keeps working when the venue's internet drops. The list comes from src/tracking/vision.ts.
// Run once per machine before `pnpm build`: pnpm models
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dest = resolve(root, 'public/models');
const sources = [...readFileSync(resolve(root, 'src/tracking/vision.ts'), 'utf8').matchAll(/'(https:\/\/storage\.googleapis\.com\/mediapipe-models\/[^']+)'/g)].map((match) => match[1]);

mkdirSync(dest, { recursive: true });
for (const url of sources) {
  const file = resolve(dest, url.split('/').pop());
  if (existsSync(file)) {
    console.log(`Have ${url.split('/').pop()}`);
    continue;
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  console.log(`Saved ${url.split('/').pop()}`);
}
