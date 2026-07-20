/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      // Exclude entry points, type-only files, and the tests themselves.
      exclude: [
        'src/main.tsx',
        'src/test/**',
        'src/domain/langfuse.ts', // type declarations only
        '**/*.d.ts',
        'dist/**',
        '*.config.ts',
      ],
      // MEASURED BASELINE, not an aspiration. Set slightly below the actual
      // numbers so CI fails on regression rather than on the status quo.
      //
      //   Measured 2026-07: lines 78.3 · statements 76.8 · funcs 70.7 · branches 68.2
      //
      // Ratchet these up as coverage improves — the point is that they can
      // only ever move in one direction. Highest-value gaps, in order:
      //   hooks/useEvals.ts  45%  — no direct tests; exercised only via routes
      //   routes/Compare.tsx 54%  — only empty/guard states are tested
      //   routes/SuiteEditor 55%  — save and partial-failure paths untested
      //   domain/rollup.ts   69%  — withLastRun and formatRate untested
      // 📖 docs/PRODUCTION_READINESS.md item 2
      thresholds: {
        lines: 78,
        functions: 70,
        statements: 76,
        branches: 68,
      },
    },
  },
});
