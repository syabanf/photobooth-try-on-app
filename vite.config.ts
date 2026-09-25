import { defineConfig } from 'vitest/config';

export default defineConfig({
  optimizeDeps: { exclude: ['@mediapipe/tasks-vision'] },
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
