import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { PERMISSION_LEVEL_DEFAULTS, type ToolDefinition } from "@ai-platform/shared";
import type { NativeToolEntry } from "./filesystem.js";

/**
 * Web retrieval — FR-011, docs/26_DECISIONS.md ADR-104.
 *
 * WHAT WAS MISSING. An "AI platform" could not read a URL. There was no fetch tool, no search
 * tool, and no row for either in the status matrix — so the completion accounting silently
 * omitted a brief-level capability. docs/13's SSRF deferral was justified on the grounds that
 * "no URL-fetching tool exists yet", which made this one feature whose absence was load-bearing
 * for a security decision: implementing it means implementing the guard the deferral postponed.
 *
 * WHY THIS IS NOT `fetch(url)`. A model choosing the URL is an untrusted caller choosing a
 * destination from inside the deployment's network. The classic consequence on a cloud host is
 * one request to 169.254.169.254 returning instance credentials; on any host it is a port
 * scanner and a reader of internal services that trust the network they are on.
 *
 * Five properties, each closing something specific:
 *
 *  1. **Scheme allowlist.** `http` and `https` only — `file://` reads the disk, `gopher://` and
 *     friends have been used to smuggle arbitrary bytes into internal protocols.
 *
 *  2. **Address validation, not hostname validation.** The hostname is resolved and EVERY
 *     resulting address is checked against the private, loopback, link-local, multicast and
 *     reserved ranges, IPv4 and IPv6 (including IPv4-mapped IPv6, which is how a blocked
 *     10.0.0.0/8 gets in as ::ffff:10.0.0.1). A blocklist of names never works: `localtest.me`
 *     resolves to 127.0.0.1, and an attacker controls their own DNS.
 *
 *  3. **The connection is pinned to the validated address.** `http.request` takes a `lookup`
 *     function, and this one returns only the address that was checked. Without it, resolving
 *     and then connecting are two separate lookups, and a DNS record with a one-second TTL can
 *     answer "public" to the first and "127.0.0.1" to the second — a rebinding attack that
 *     defeats validation performed any other way.
 *
 *  4. **Redirects are followed by hand, and every hop is revalidated.** A public URL that
 *     302s to 169.254.169.254 is the single most common SSRF bypass; letting the HTTP client
 *     follow redirects would check the first address and none of the rest.
 *
 *  5. **Bounded output and no credentials.** A cap on bytes, a timeout, an allowlist of content
 *     types, no cookies, and no `Authorization` header — the tool cannot be used to spend the
 *     deployment's ambient credentials, and cannot flood the model's context.
 *
 * An optional host allowlist (`WEB_FETCH_ALLOWLIST`) narrows it further for a deployment that
 * wants the capability only for named sites.
 */

const MAX_RESPONSE_BYTES = 512_000;
const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 15_000;

/** Types worth giving to a model. A binary body would be noise at best. */
const ALLOWED_CONTENT_TYPES = [
  "text/html",
  "text/plain",
  "text/markdown",
  "text/xml",
  "application/json",
  "application/xml",
  "application/xhtml+xml",
  "application/ld+json",
];

export interface WebFetchOptions {
  /** Hostnames the deployment permits. Empty means "any public address". */
  allowlist?: string[];
  timeoutMs?: number;
  maxBytes?: number;
  /**
   * The address policy. Defaults to `isBlockedAddress`, which is the guard.
   *
   * Injectable for ONE reason: the HTTP mechanics — redirect revalidation, the byte cap,
   * content-type refusal, timeouts — can only be tested against a real server, and a server a
   * test can start is on loopback by definition. A test therefore supplies a policy that
   * permits its own loopback port while still refusing everything else, which is stricter and
   * more honest than a blanket "allow private addresses" switch: the redirect test permits
   * 127.0.0.1 and still proves 169.254.169.254 is refused mid-chain.
   *
   * `createWebTools` never sets it and nothing reads it from configuration, so no deployment
   * can weaken the policy. That the default refuses loopback is asserted separately.
   */
  isAddressBlocked?: (address: string) => boolean;
  /** Injected in tests so address validation can be exercised without real DNS. */
  resolve?: (hostname: string) => Promise<string[]>;
}

export interface WebFetchResult {
  url: string;
  status: number;
  contentType: string | null;
  /** Text, already extracted from HTML when the response was HTML. */
  content: string;
  truncated: boolean;
  /** Every URL in the redirect chain, in order, so the caller can see where it ended up. */
  chain: string[];
}

/**
 * Is this address one the platform must refuse to talk to?
 *
 * Written as an explicit range check rather than a regular expression: `10.0.0.1` and
 * `010.0.0.1` and `167772161` are the same address to a resolver and different strings to a
 * pattern, and this has to be right about the address rather than about its spelling.
 */
export function isBlockedAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 0) return true; // not an address at all: refuse rather than guess
  return version === 4 ? isBlockedIpv4(address) : isBlockedIpv6(address);
}

function isBlockedIpv4(address: string): boolean {
  const parts = address.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 carrier NAT
  if (a === 169 && b === 254) return true; // link-local -- the cloud metadata endpoint
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 protocol assignments, 192.0.2.0/24 doc
  if (a === 192 && b === 168) return true; // private
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51) return true; // documentation
  if (a === 203 && b === 0) return true; // documentation
  if (a >= 224) return true; // multicast and reserved
  return false;
}

/**
 * Expands an IPv6 address to its eight 16-bit groups, or null if it cannot be parsed.
 *
 * Written because the first version of this guard compared string PREFIXES, and string prefixes
 * are not a property of an address. `[::ffff:127.0.0.1]` is normalised by the URL parser to
 * `::ffff:7f00:1` — the same address, spelled in hex — which a regex looking for four decimal
 * octets does not match, so it fell past every remaining check and came back permitted. The test
 * written to prove the decimal forms were refused is what caught it.
 */
export function expandIpv6(address: string): number[] | null {
  let text = address.toLowerCase();
  // A zone index (`fe80::1%eth0`) names a local interface and is never a routable destination.
  const percent = text.indexOf("%");
  if (percent !== -1) text = text.slice(0, percent);

  // A trailing dotted-quad is the IPv4-mapped/compatible spelling; convert it to two groups.
  const dotted = /^(.*:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(text);
  if (dotted) {
    const octets = dotted[2].split(".").map(Number);
    if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    text = dotted[1] + hi + ":" + lo;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1) {
    if (head.length !== 8) return null;
  } else if (fill < 0) {
    return null;
  }
  const groups = [...head, ...Array.from({ length: halves.length === 2 ? fill : 0 }, () => "0"), ...tail];
  if (groups.length !== 8) return null;
  const out: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    out.push(parseInt(group, 16));
  }
  return out;
}

function isBlockedIpv6(address: string): boolean {
  const g = expandIpv6(address);
  if (!g) return true; // unparseable: refuse rather than guess

  // Any form that embeds an IPv4 address is unwrapped and judged by the v4 rules, so the two
  // families cannot disagree. Three distinct prefixes do this:
  //   ::ffff:0:0/96   IPv4-mapped      (g[4] = 0, g[5] = ffff)
  //   ::/96           IPv4-compatible  (g[4] = 0, g[5] = 0)
  //   ::ffff:0:0:0/96 IPv4-translated  (g[4] = ffff, g[5] = 0) -- RFC 2765 SIIT
  // The third was missed by the first version of this function, which required g[0..4] to be
  // zero: `::ffff:0:7f00:1` is loopback and came back permitted.
  const topFourZero = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0;
  const embedsIpv4 =
    topFourZero &&
    ((g[4] === 0 && (g[5] === 0xffff || g[5] === 0)) || (g[4] === 0xffff && g[5] === 0));
  if (embedsIpv4) {
    const embedded = [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join(".");
    // `::` and `::1` fall in this range too and are caught by isBlockedIpv4's 0.0.0.0/8 rule
    // (0.0.0.0 and 0.0.0.1 respectively), so they need no special case.
    return isBlockedIpv4(embedded);
  }

  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  // fec0::/10 site-local. Deprecated by RFC 3879 and therefore easy to leave out — but a
  // deprecated range is still routed by stacks that were configured before it was deprecated,
  // and "the RFC says nobody should use this" is not a reason to let a tool reach it.
  if ((g[0] & 0xffc0) === 0xfec0) return true;
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g[0] === 0x64 && g[1] === 0xff9b) return true; // 64:ff9b::/96 NAT64 -> IPv4 space
  if (g[0] === 0x2002) return true; // 2002::/16 6to4 -> IPv4 space
  // 2001::/32 Teredo, which tunnels IPv6 over IPv4 and embeds an arbitrary IPv4 address in the
  // low bits — the same reachability as 6to4 and NAT64 above, by a third mechanism.
  if (g[0] === 0x2001 && g[1] === 0) return true;
  if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // 100::/64 discard
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true; // documentation
  return false;
}

/** Extremely plain HTML-to-text. A parser dependency would buy little for a model's purposes. */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    // Script and style content is not prose and is the bulk of most pages.
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function validatedAddress(hostname: string, options: WebFetchOptions): Promise<string> {
  const blocked = options.isAddressBlocked ?? isBlockedAddress;
  // A literal address in the URL is validated directly; there is nothing to resolve.
  //
  // Brackets are stripped first. `new URL("http://[::1]/").hostname` keeps them, so `isIP`
  // returns 0 and the address would fall through to the resolver — which happens to refuse it on
  // this platform, but only because `dns.lookup` tolerated a bracketed name. Relying on that is
  // relying on a resolver's error handling for a security decision; validating the literal
  // directly does not depend on it.
  const literal = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (isIP(literal) !== 0) {
    if (blocked(literal)) {
      throw new Error(`Refusing to fetch a non-public address (${literal}).`);
    }
    return literal;
  }

  const addresses = options.resolve
    ? await options.resolve(hostname)
    : (await dnsLookup(hostname, { all: true })).map((entry) => entry.address);

  if (addresses.length === 0) throw new Error(`Could not resolve "${hostname}".`);
  // EVERY address must be acceptable, not merely the first: a hostname that resolves to one
  // public and one private address would otherwise be fetchable on a retry.
  for (const address of addresses) {
    if (blocked(address)) {
      throw new Error(`Refusing to fetch "${hostname}": it resolves to a non-public address (${address}).`);
    }
  }
  return addresses[0];
}

function checkAllowlist(hostname: string, allowlist: string[] | undefined): void {
  if (!allowlist || allowlist.length === 0) return;
  const host = hostname.toLowerCase();
  const permitted = allowlist.some((entry) => {
    const e = entry.toLowerCase().replace(/^\./, "");
    return host === e || host.endsWith("." + e);
  });
  if (!permitted) {
    throw new Error(`Refusing to fetch "${hostname}": this deployment allows only ${allowlist.join(", ")}.`);
  }
}

export async function fetchWebPage(rawUrl: string, options: WebFetchOptions = {}): Promise<WebFetchResult> {
  const maxBytes = Math.min(options.maxBytes ?? MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const chain: string[] = [];
  let current = rawUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = new URL(current);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`Only http and https URLs can be fetched (got "${url.protocol}").`);
    }
    // A URL carrying credentials is refused rather than stripped: silently dropping them would
    // send an unauthenticated request the caller believes was authenticated.
    if (url.username || url.password) {
      throw new Error("Refusing a URL that embeds credentials.");
    }
    checkAllowlist(url.hostname, options.allowlist);
    const address = await validatedAddress(url.hostname, options);
    chain.push(current);

    const response = await once(url, address, timeoutMs, maxBytes);
    if (response.redirectTo) {
      if (hop === MAX_REDIRECTS) throw new Error(`Too many redirects (stopped at ${MAX_REDIRECTS}).`);
      // Resolved against the current URL, then revalidated from the top of the loop — a
      // relative `Location` is common and a redirect to a private address is the usual bypass.
      current = new URL(response.redirectTo, current).toString();
      continue;
    }

    const contentType = response.contentType?.split(";")[0].trim().toLowerCase() ?? null;
    if (contentType && !ALLOWED_CONTENT_TYPES.includes(contentType)) {
      throw new Error(`Refusing content type "${contentType}" — only text, HTML, JSON and XML are readable.`);
    }
    const body = response.body.toString("utf8");
    const content = contentType === "text/html" || contentType === "application/xhtml+xml" ? htmlToText(body) : body;
    return {
      url: current,
      status: response.status,
      contentType,
      content,
      truncated: response.truncated,
      chain,
    };
  }
  throw new Error("Too many redirects.");
}

interface RawResponse {
  status: number;
  contentType: string | null;
  body: Buffer;
  truncated: boolean;
  redirectTo: string | null;
}

/** One request, to one already-validated address, with the connection pinned to it. */
function once(url: URL, address: string, timeoutMs: number, maxBytes: number): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: "GET",
        // THE pin. Returning the validated address means the socket cannot be opened to a
        // different one, which is what closes the DNS-rebinding window that validation alone
        // leaves open. `servername` is left to the hostname so TLS still verifies correctly.
        lookup: (_hostname: string, opts: unknown, callback: (...args: never[]) => void) => {
          const family = isIP(address);
          const cb = callback as unknown as (err: Error | null, addr: string, fam: number) => void;
          if ((opts as { all?: boolean } | undefined)?.all) {
            (callback as unknown as (err: Error | null, addrs: Array<{ address: string; family: number }>) => void)(
              null,
              [{ address, family }]
            );
            return;
          }
          cb(null, address, family);
        },
        headers: {
          // Identifies the caller honestly. A tool that disguises itself as a browser is a tool
          // whose traffic an operator cannot recognise in their own logs.
          "user-agent": "ai-platform-web-fetch/1.0 (+agent tool)",
          accept: ALLOWED_CONTENT_TYPES.join(", "),
          "accept-encoding": "identity",
        },
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location) {
          res.resume(); // drain, so the socket is freed
          resolve({ status, contentType: null, body: Buffer.alloc(0), truncated: false, redirectTo: location });
          return;
        }

        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        res.on("data", (chunk: Buffer) => {
          if (truncated) return;
          size += chunk.length;
          if (size > maxBytes) {
            // Stop reading rather than buffering the rest: the cap exists to bound memory as
            // well as the model's context.
            truncated = true;
            chunks.push(chunk.subarray(0, Math.max(0, maxBytes - (size - chunk.length))));
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        const finish = () =>
          resolve({
            status,
            contentType: (res.headers["content-type"] as string | undefined) ?? null,
            body: Buffer.concat(chunks),
            truncated,
            redirectTo: null,
          });
        res.on("end", finish);
        res.on("close", finish);
        res.on("error", (err) => (truncated ? finish() : reject(err)));
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error(`Request to ${url.hostname} timed out after ${timeoutMs}ms.`));
    });
    req.on("error", reject);
    req.end();
  });
}

export function createWebTools(options: WebFetchOptions = {}): NativeToolEntry[] {
  const defaults = PERMISSION_LEVEL_DEFAULTS.network;
  const definition: ToolDefinition = {
    id: "web.fetch",
    name: "Fetch a web page",
    description:
      "Fetch a public http(s) URL and return its text (HTML is converted to text). Use this to read documentation, an article or a JSON endpoint. Private, loopback and cloud-metadata addresses are refused.",
    origin: { kind: "native", serverId: null, serverVersion: null },
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "An absolute http:// or https:// URL." },
        maxBytes: { type: "integer", minimum: 1_000, maximum: MAX_RESPONSE_BYTES },
      },
      required: ["url"],
      additionalProperties: false,
    },
    outputSchema: null,
    permissionLevel: "network",
    riskLevel: defaults.riskLevel,
    requiresApproval: defaults.requiresApproval,
    timeoutMs: defaults.timeoutMs,
    retryPolicy: { maxAttempts: defaults.maxAttempts, backoff: "exponential", idempotencyRequired: false },
    enabled: true,
  };

  return [
    {
      definition,
      handler: async (args) => {
        try {
          const result = await fetchWebPage(String(args.url), {
            ...options,
            maxBytes: args.maxBytes === undefined ? options.maxBytes : Number(args.maxBytes),
          });
          return { ok: true, output: { ...result } };
        } catch (err) {
          // A refusal is an answer the model can act on (pick a different source), not a crash.
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
  ];
}
