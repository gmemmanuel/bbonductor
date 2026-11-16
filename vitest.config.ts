import { defineConfig } from "vitest/config";

// Only this plugin's own tests: `.context/` holds the live check's scratch
// checkout of bb, which has test files of its own.
export default defineConfig({
  test: { include: ["tests/**/*.test.ts"] },
});
