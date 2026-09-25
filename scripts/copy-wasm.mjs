// Copies the MediaPipe wasm runtime into public/wasm so Vite serves it same-origin.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'node_modules/@mediapipe/tasks-vision/wasm');
const dest = resolve(root, 'public/wasm');

if (!existsSync(src)) {
  console.error('Missing @mediapipe/tasks-vision. Run `pnpm install` first.');
  process.exit(1);
}
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`Copied wasm runtime to ${dest}`);
