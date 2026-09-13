import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../../vitest.config.base.js";

/** Runs ONLY the real-container suite — ADR-111. Pulling an image can be slow, hence the timeouts. */
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      testTimeout: 180_000,
      hookTimeout: 180_000,
      include: ["src/**/*.docker.test.ts"],
    },
  })
);
