import baseConfig from "../../../vitest.config.base.js";

// Timeouts only — see vitest.config.base.ts (ADR-100). This package relies on
// vitest's own test-file discovery.
export default baseConfig;
