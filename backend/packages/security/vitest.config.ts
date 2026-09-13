import { configDefaults, defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../../vitest.config.base.js";

/**
 * The real-container suite (`*.docker.test.ts`) is excluded here and run only by
 * `npm run test:docker` (vitest.docker.config.ts) — ADR-111. Running it by default would turn every
 * machine without docker into a failing build; skipping it by default would put a skip in CI, which
 * the zero-skip gate rejects. A separate, explicit command is the honest shape.
 */
export default mergeConfig(
  baseConfig,
  defineConfig({ test: { exclude: [...configDefaults.exclude, "src/**/*.docker.test.ts"] } })
);
