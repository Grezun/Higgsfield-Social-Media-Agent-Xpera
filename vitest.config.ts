import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.{ts,tsx}"],
    testTimeout: 60_000,
    passWithNoTests: true,
  },
});
