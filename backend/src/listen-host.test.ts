import { describe, expect, it } from "vitest";
import { resolveListenHost } from "./config.js";

/**
 * Which interface the API listens on — docs/26_DECISIONS.md ADR-113.
 *
 * It was 0.0.0.0 unconditionally. On a developer's machine that put the whole platform on the LAN
 * with development's defaults: open signup, process-level isolation for agent commands, and a
 * self-registered user who owns their project and can approve their own tool calls. Loopback is the
 * development default; production, where a container must accept its platform's traffic, is not.
 */
describe("resolveListenHost", () => {
  it("listens on loopback only outside production", () => {
    expect(resolveListenHost({ NODE_ENV: "development", HOST: undefined })).toBe("127.0.0.1");
    expect(resolveListenHost({ NODE_ENV: "test", HOST: undefined })).toBe("127.0.0.1");
  });

  it("listens on every interface in production", () => {
    expect(resolveListenHost({ NODE_ENV: "production", HOST: undefined })).toBe("0.0.0.0");
  });

  it("uses HOST when an operator sets it, in either direction", () => {
    expect(resolveListenHost({ NODE_ENV: "development", HOST: "0.0.0.0" })).toBe("0.0.0.0");
    expect(resolveListenHost({ NODE_ENV: "production", HOST: "127.0.0.1" })).toBe("127.0.0.1");
  });
});
