import { describe, expect, it } from "vitest";
import { isLoopbackHost } from "./client.js";

/**
 * docs/26_DECISIONS.md ADR-083 — the plaintext-credential guard, and the hole that was in it.
 *
 * `parseMcpServerConfigs` refuses an `http://` (not https) MCP server that carries credential
 * headers, UNLESS the host is loopback — where there is no network for a token to cross. The
 * original check was `/^127\./`, which matches any hostname merely BEGINNING with "127.":
 *
 *   isLoopbackHost("127.0.0.1.attacker.tld") === true
 *
 * That is an ordinary DNS name an attacker registers and points anywhere. A config naming it over
 * plain http passed the guard that exists to refuse precisely that, and the bearer token went out
 * in clear to the attacker's server. Caught in review before it shipped.
 *
 * The first two tests are the ones that matter; the rest exist so a future "simplification" back
 * to a prefix match cannot pass.
 */
describe("isLoopbackHost", () => {
  it("REFUSES a DNS name that merely starts with 127.", () => {
    // The exact string from the review finding.
    expect(isLoopbackHost("127.0.0.1.attacker.tld")).toBe(false);
    expect(isLoopbackHost("127.0.0.1.evil.example.com")).toBe(false);
    // And the same trick with the other loopback spellings.
    expect(isLoopbackHost("localhost.attacker.tld")).toBe(false);
    expect(isLoopbackHost("notlocalhost")).toBe(false);
  });

  it("accepts real loopback addresses", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("::ffff:127.0.0.1")).toBe(true);
  });

  it("accepts the whole 127.0.0.0/8 block, which is all loopback", () => {
    // Not just 127.0.0.1: the entire /8 is loopback, and a developer binding a server to
    // 127.0.0.2 to separate two local services should not be refused.
    expect(isLoopbackHost("127.0.0.2")).toBe(true);
    expect(isLoopbackHost("127.1.2.3")).toBe(true);
    expect(isLoopbackHost("127.255.255.255")).toBe(true);
  });

  it("refuses addresses outside the loopback block", () => {
    expect(isLoopbackHost("128.0.0.1")).toBe(false);
    expect(isLoopbackHost("10.0.0.1")).toBe(false);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    // 0.0.0.0 deserves its own mention: binding to it is not the same as connecting to
    // loopback, and a credential sent to it can leave the host.
    expect(isLoopbackHost("192.168.1.1")).toBe(false);
  });

  it("refuses malformed near-misses rather than guessing", () => {
    expect(isLoopbackHost("127.0.0")).toBe(false);
    expect(isLoopbackHost("127.0.0.1.1")).toBe(false);
    expect(isLoopbackHost("127.0.0.256")).toBe(false);
    expect(isLoopbackHost("127.0.0.x")).toBe(false);
    expect(isLoopbackHost("")).toBe(false);
  });

  it("is case-insensitive, because hostnames are", () => {
    expect(isLoopbackHost("LOCALHOST")).toBe(true);
    expect(isLoopbackHost("LocalHost")).toBe(true);
  });
});
