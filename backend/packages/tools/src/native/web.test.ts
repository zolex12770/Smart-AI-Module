import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolInvocationContext } from "@ai-platform/shared";
import { createWebTools, fetchWebPage, htmlToText, isBlockedAddress } from "./web.js";

/**
 * `web.fetch` and its SSRF guard — FR-011, docs/26_DECISIONS.md ADR-104.
 *
 * A model choosing the URL is an untrusted caller choosing a destination from inside the
 * deployment's network, so the guard is the feature as much as the fetching is. These drive a
 * REAL local HTTP server for the request paths, and inject a resolver only where the point is
 * what DNS returned — asserting on a mocked fetch would prove nothing about a guard whose whole
 * job is to decide which socket may be opened.
 */
describe("isBlockedAddress", () => {
  it("refuses every private, loopback, link-local and reserved IPv4 range", () => {
    for (const address of [
      "127.0.0.1",
      "127.1.1.1",
      "0.0.0.0",
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // the cloud metadata endpoint — the one that returns credentials
      "100.64.0.1",
      "224.0.0.1",
      "255.255.255.255",
      "192.0.2.1",
      "198.18.0.1",
    ]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it("permits ordinary public IPv4 addresses", () => {
    for (const address of ["1.1.1.1", "8.8.8.8", "93.184.216.34", "172.32.0.1", "172.15.0.1", "192.167.1.1"]) {
      expect(isBlockedAddress(address), address).toBe(false);
    }
  });

  it("refuses the IPv6 forms that carry a blocked IPv4 address inside them", () => {
    // This is the bypass a naive IPv4-only check misses entirely.
    for (const address of ["::1", "::", "::ffff:127.0.0.1", "::ffff:169.254.169.254", "::ffff:10.0.0.1"]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it("refuses IPv6 link-local, unique-local, multicast and translation ranges", () => {
    for (const address of ["fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "64:ff9b::1.2.3.4", "2002::1"]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it("refuses an IPv4-mapped address written in HEX, not only in decimal", () => {
    // The bypass this guard's first version had. `new URL("http://[::ffff:127.0.0.1]/").hostname`
    // normalises to `::ffff:7f00:1`, so a regex looking for four decimal octets matched nothing
    // and the address fell past every remaining check as permitted. Found by the test written to
    // prove the DECIMAL forms were refused, which is why both spellings are asserted here.
    for (const address of [
      "::ffff:7f00:1",
      "::ffff:a9fe:a9fe", // 169.254.169.254, the metadata endpoint
      "::ffff:a00:1", // 10.0.0.1
      "0:0:0:0:0:ffff:7f00:1", // fully expanded
      "::ffff:0a00:0001", // zero-padded groups
    ]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it("refuses an address carrying a zone index, which names a local interface", () => {
    expect(isBlockedAddress("fe80::1%eth0")).toBe(true);
  });

  it("refuses the edges of each blocked IPv6 range, not just the first address in it", () => {
    for (const address of ["febf::1", "fdff::1", "ff02::1", "2001:db8::1", "100::1"]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });


  it("refuses the ranges an independent audit found unblocked", () => {
    // Each of these was permitted by the version of this guard that had already been reviewed,
    // tested and committed — found by a second pass that went looking specifically for ranges the
    // first had missed. They are three separate mechanisms for reaching IPv4 space or a local
    // interface, which is why one pattern did not cover them.
    for (const address of [
      "::ffff:0:7f00:1", // ::ffff:0:0:0/96 IPv4-translated (RFC 2765 SIIT) -> 127.0.0.1
      "::ffff:0:a9fe:a9fe", // the same form -> 169.254.169.254
      "2001:0:4136:e378:8000:63bf:3fff:fdd2", // Teredo 2001::/32, embeds an arbitrary IPv4
      "fec0::1", // site-local; deprecated by RFC 3879, still routed by stacks configured earlier
      "feff::1", // the top of fec0::/10
    ]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it("does not over-block the 2001::/16 neighbours of Teredo", () => {
    // Teredo is 2001::/32 — only when the second group is zero. `2001:1::1` and `2003::1` are
    // ordinary global addresses, and a guard that refuses everything is not a guard.
    expect(isBlockedAddress("2001:1::1")).toBe(false);
    expect(isBlockedAddress("2003::1")).toBe(false);
  });


  it("permits a public IPv6 address", () => {
    expect(isBlockedAddress("2606:4700:4700::1111")).toBe(false);
  });

  it("refuses anything that is not an address at all, rather than guessing", () => {
    for (const value of ["", "localhost", "10.0.0", "not-an-address", "10.0.0.1.5"]) {
      expect(isBlockedAddress(value), value).toBe(true);
    }
  });
});

describe("htmlToText", () => {
  it("drops script and style content, which is most of a real page", () => {
    const text = htmlToText("<p>Kept</p><script>var secret = 1;</script><style>.a{color:red}</style>");
    expect(text).toContain("Kept");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("color:red");
  });

  it("keeps block structure as newlines and decodes the common entities", () => {
    expect(htmlToText("<h1>Title</h1><p>One &amp; two</p>")).toBe("Title\nOne & two");
  });
});

describe("fetchWebPage against a real server", () => {
  let server: Server;
  let port: number;
  let lastPath: string | undefined;
  let handler: (path: string) => { status: number; headers: Record<string, string>; body: string };

  beforeEach(async () => {
    handler = () => ({ status: 200, headers: { "content-type": "text/plain" }, body: "default" });
    server = createServer((req, res) => {
      lastPath = req.url;
      const result = handler(req.url ?? "/");
      res.writeHead(result.status, result.headers);
      res.end(result.body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** The server is on loopback, so a test that means to SUCCEED must disable the guard
   *  explicitly. Every test that means to be REFUSED leaves it on. */
  /**
   * A policy that permits ONLY this test server's loopback address and refuses everything the
   * real guard refuses. Stricter than a blanket override: the redirect test below reaches the
   * local server on hop one and still proves 169.254.169.254 is refused on hop two.
   */
  const allowLoopback = {
    // `example.test` is a reserved name that does not resolve, so DNS is supplied too.
    resolve: async () => ["127.0.0.1"],
    isAddressBlocked: (address: string) => address !== "127.0.0.1" && isBlockedAddress(address),
  };
  const url = (path = "/") => `http://example.test:${port}${path}`;

  it("refuses loopback by default — the local server is unreachable without an override", async () => {
    await expect(fetchWebPage(`http://127.0.0.1:${port}/`)).rejects.toThrow(/non-public address/);
  });

  it("refuses the cloud metadata endpoint by name as well as by address", async () => {
    await expect(fetchWebPage("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(/non-public address/);
    await expect(
      fetchWebPage("http://metadata.internal/computeMetadata/", { resolve: async () => ["169.254.169.254"] })
    ).rejects.toThrow(/non-public address/);
  });

  it("refuses a hostname that resolves to ANY blocked address, not merely the first", async () => {
    // A record set with one public and one private address must not be fetchable on a retry.
    await expect(
      fetchWebPage("http://mixed.test/", { resolve: async () => ["93.184.216.34", "127.0.0.1"] })
    ).rejects.toThrow(/non-public address/);
  });

  it("refuses every alternative encoding of a blocked address", async () => {
    // Node's URL parser normalises octal, decimal, hex and short-form IPv4 to dotted-quad, so
    // the range check sees the real address — asserted rather than assumed, because a guard that
    // only understands one spelling of 127.0.0.1 is the classic SSRF bypass.
    for (const url of [
      "http://0177.0.0.1/",
      "http://2130706433/",
      "http://127.1/",
      "http://0x7f.0x0.0x0.0x1/",
      "http://0/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
    ]) {
      await expect(fetchWebPage(url, { timeoutMs: 2_000 }), url).rejects.toThrow(/non-public address/);
    }
  });

  it("refuses a blocked host however it is spelled", async () => {
    for (const url of ["http://LOCALHOST/", "http://localhost./"]) {
      await expect(fetchWebPage(url, { timeoutMs: 2_000 }), url).rejects.toThrow(/non-public address/);
    }
  });


  it("refuses a non-http scheme", async () => {
    await expect(fetchWebPage("file:///etc/passwd")).rejects.toThrow(/only http and https/i);
    await expect(fetchWebPage("gopher://example.com/")).rejects.toThrow(/only http and https/i);
  });

  it("refuses a URL that embeds credentials rather than silently dropping them", async () => {
    await expect(fetchWebPage("http://user:pass@example.com/")).rejects.toThrow(/embeds credentials/);
  });

  it("fetches text and reports the content type", async () => {
    handler = () => ({ status: 200, headers: { "content-type": "text/plain" }, body: "hello from the server" });
    const result = await fetchWebPage(url("/page"), allowLoopback);
    expect(result.status).toBe(200);
    expect(result.content).toBe("hello from the server");
    expect(result.contentType).toBe("text/plain");
    expect(lastPath).toBe("/page");
  });

  it("converts HTML to text", async () => {
    handler = () => ({
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: "<html><body><h1>Docs</h1><p>The flag is <code>--verbose</code>.</p><script>x()</script></body></html>",
    });
    const result = await fetchWebPage(url(), allowLoopback);
    expect(result.content).toContain("Docs");
    expect(result.content).toContain("--verbose");
    expect(result.content).not.toContain("x()");
  });

  it("revalidates every redirect hop — a public URL that 302s to the metadata endpoint is refused", async () => {
    // The single most common SSRF bypass, and the reason redirects are followed by hand.
    handler = (path) =>
      path === "/redirect"
        ? { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" }, body: "" }
        : { status: 200, headers: { "content-type": "text/plain" }, body: "should never be reached" };
    await expect(fetchWebPage(url("/redirect"), allowLoopback)).rejects.toThrow(/non-public address/);
  });

  it("applies every check to the redirect TARGET, not only to the first URL", async () => {
    // Each of these is a real bypass attempt against a guard that validates only the URL it was
    // given: the scheme check, the credential check and the address check all have to run again
    // on each hop, which is the reason redirects are followed by hand rather than by the client.
    const cases: Array<[string, string, RegExp]> = [
      ["/ws", " http://169.254.169.254/", /non-public address/],
      ["/scheme", "file:///etc/passwd", /only http and https/i],
      ["/userinfo", "http://user:pw@example.com/", /embeds credentials/],
    ];
    for (const [path, location, expected] of cases) {
      handler = (p) => (p === path ? { status: 302, headers: { location }, body: "" } : { status: 200, headers: { "content-type": "text/plain" }, body: "reached" });
      await expect(fetchWebPage(url(path), allowLoopback), path).rejects.toThrow(expected);
    }
  });


  it("follows a redirect that stays permitted, and reports the chain", async () => {
    handler = (path) =>
      path === "/from"
        ? { status: 302, headers: { location: "/to" }, body: "" }
        : { status: 200, headers: { "content-type": "text/plain" }, body: "arrived" };
    const result = await fetchWebPage(url("/from"), allowLoopback);
    expect(result.content).toBe("arrived");
    expect(result.chain).toHaveLength(2);
    expect(result.url).toContain("/to");
  });

  it("stops after a bounded number of redirects", async () => {
    handler = () => ({ status: 302, headers: { location: "/loop" }, body: "" });
    await expect(fetchWebPage(url("/loop"), allowLoopback)).rejects.toThrow(/too many redirects/i);
  });

  it("refuses a content type that is not readable text", async () => {
    handler = () => ({ status: 200, headers: { "content-type": "application/octet-stream" }, body: " " });
    await expect(fetchWebPage(url(), allowLoopback)).rejects.toThrow(/content type/i);
  });

  it("truncates a large body instead of handing the model an unbounded page", async () => {
    handler = () => ({ status: 200, headers: { "content-type": "text/plain" }, body: "x".repeat(50_000) });
    const result = await fetchWebPage(url(), { ...allowLoopback, maxBytes: 1_000 });
    expect(result.truncated).toBe(true);
    expect(result.content.length).toBeLessThanOrEqual(1_000);
  });

  it("honours a host allowlist when the deployment sets one", async () => {
    handler = () => ({ status: 200, headers: { "content-type": "text/plain" }, body: "ok" });
    await expect(
      fetchWebPage(url(), { ...allowLoopback, allowlist: ["docs.internal.example"] })
    ).rejects.toThrow(/allows only/);
    // Subdomains of an allowlisted host are permitted; unrelated hosts are not.
    const result = await fetchWebPage(url(), { ...allowLoopback, allowlist: ["example.test"] });
    expect(result.content).toBe("ok");
  });

  it("gives up on a server that never responds", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createServer(() => {
      /* accept and never answer */
    });
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    await expect(fetchWebPage(url(), { ...allowLoopback, timeoutMs: 300 })).rejects.toThrow(/timed out/i);
  });
});

describe("the registered tool", () => {
  const ctx = { projectId: "p1", userId: "u1" } as ToolInvocationContext;

  it("returns a refusal as an answer, not as a crash", async () => {
    const [tool] = createWebTools();
    const result = await tool.handler({ url: "http://169.254.169.254/" }, ctx);
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/non-public address/);
  });

  it("declares itself a network tool, not a read_only one", async () => {
    const [tool] = createWebTools();
    expect(tool.definition.id).toBe("web.fetch");
    expect(tool.definition.permissionLevel).toBe("network");
    expect(tool.definition.riskLevel).toBe("medium");
  });
});
