import { defineConfig } from "vitest/config";

// Media tests launch native encoders. Serialize files so concurrent suites do not
// compete for the same machine's CPU, font cache, and process limits.
export default defineConfig({
  test: { fileParallelism: false, testTimeout: 30000, hookTimeout: 30000 },
});
