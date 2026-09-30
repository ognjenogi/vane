const { defineConfig } = require('vitest/config');
const path = require('path');

module.exports = defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  esbuild: { jsx: 'automatic' },
  oxc: false,
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
  },
});
