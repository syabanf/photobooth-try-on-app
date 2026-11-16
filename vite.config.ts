import { defineConfig } from 'vitest/config';
// @ts-expect-error: a plain Node module shared with scripts/serve.mjs, with no type declarations.
import { handleCameraProxy } from './scripts/camera-proxy.mjs';
// @ts-expect-error: the same.
import { qrisHandler } from './scripts/qris-mutations.mjs';

const handleQris = qrisHandler(`${process.env.PHOTO_DATA_DIR || '.photo-delivery'}/qris.json`);

export default defineConfig({
  // The dev server answers /api/camera/... and /api/qris/... the same way `pnpm serve` does, so
  // DSLR setup and static QRIS payments work in both.
  plugins: [{ name: 'booth-api', configureServer: (server) => void server.middlewares.use((req, res, next) => (handleCameraProxy(req, res) || handleQris(req, res) ? undefined : next())) }],
  optimizeDeps: { exclude: ['@mediapipe/tasks-vision'] },
  // LiveKit (512 kB) is the largest chunk and loads only when someone starts Decart AI mode, so
  // the warning stays quiet for it and still fires if an eagerly loaded chunk grows past it.
  build: { chunkSizeWarningLimit: 520 },
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
