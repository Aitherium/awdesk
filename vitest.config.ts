import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // .tsx: component render tests (react-dom/server, no DOM needed).
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
