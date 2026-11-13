import { defineConfig } from 'vitest/config';
// @ts-expect-error: a plain Node module shared with scripts/serve.mjs, with no type declarations.
import { handleCameraProxy } from './scripts/camera-proxy.mjs';

export default defineConfig({
  // The dev server answers /api/camera/... the same way `pnpm serve` does, so DSLR setup works in both.
  plugins: [{ name: 'camera-proxy', configureServer: (server) => void server.middlewares.use((req, res, next) => (handleCameraProxy(req, res) ? undefined : next())) }],
  optimizeDeps: { exclude: ['@mediapipe/tasks-vision'] },
  // LiveKit (512 kB) is the largest chunk and loads only when someone starts Decart AI mode, so
  // the warning stays quiet for it and still fires if an eagerly loaded chunk grows past it.
  build: { chunkSizeWarningLimit: 520 },
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
