import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only our own tests: native/ contains JUCE's source tree (fetched by
    // CMake), which ships its own unrelated test files.
    include: ['src/**/*.test.ts'],
  },
});
