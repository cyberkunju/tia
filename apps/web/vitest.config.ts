import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Separate from vite.config.ts on purpose: the app build (tsc -b && vite build)
// must not pull in test-only settings. tsconfig.node only compiles vite.config.ts,
// so this file is never type-checked by the build either.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      // Genuine non-testables: the DOM bootstrap has no logic to assert, and
      // ambient type declarations / vite's env shim emit no runtime code.
      exclude: ["src/main.tsx", "src/**/*.d.ts", "src/vite-env.d.ts"],
      reporter: ["text", "html"],
      // CI gate: every axis is fully covered. Genuinely unreachable defensive
      // branches (caller-guarded helpers, `enabled`-gated react-query queryFns,
      // data-invariant fallbacks) carry justified `/* v8 ignore */` comments in
      // the source; everything else is exercised by real behavioural tests.
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
});
