import { defineConfig } from 'vitest/config';

export default defineConfig({
  optimizeDeps: { exclude: ['@mediapipe/tasks-vision'] },
  // LiveKit (512 kB) is the largest chunk and loads only when someone starts Decart AI mode, so
  // the warning stays quiet for it and still fires if an eagerly loaded chunk grows past it.
  build: { chunkSizeWarningLimit: 520 },
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
