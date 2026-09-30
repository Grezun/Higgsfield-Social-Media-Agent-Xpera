import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.{ts,tsx}", "apps/*/src/**/*.test.{ts,tsx}", "apps/web/lib/**/*.test.ts"],
    testTimeout: 60_000,
    passWithNoTests: true,
  },
});
