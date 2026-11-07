import { defineConfig } from "vitest/config";
import { TEST_TIMEOUTS } from "./vitest.config.base.js";

export default defineConfig({
  test: {
    ...TEST_TIMEOUTS,
  },
});
