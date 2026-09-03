import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClamAvScanner, parseInstreamReply } from "./clamav-scanner.js";

/**
 * The reply grammar is testable without a daemon; the protocol itself is tested against a
 * REAL clamd process (docs/26_DECISIONS.md ADR-042) when `CLAMD_BIN` points at one — ClamAV
 * is a 200 MB install and isn't checked in, so the suite skips itself LOUDLY otherwise;
 * `.github/workflows/ci.yml` installs it so CI runs this for real.
 *
 * No full virus database is needed (and none is downloaded): clamd is started against a
 * one-line custom signature database containing only the EICAR test signature, in ClamAV's
 * own `.ndb` format. The EICAR sample itself is assembled in memory from two halves and sent
 * over the socket — it is never written to disk as a contiguous string, on purpose, so a
 * host antivirus never sees a file to quarantine.
 */
const CLAMD_BIN = process.env.CLAMD_BIN;
const PORT = Number(process.env.CLAMD_TEST_PORT ?? 33100);

// Assembled at runtime; never a single literal in source (see above).
const EICAR = Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD" + "-ANTIVIRUS-TEST-FILE!$H+H*", "latin1");

describe("parseInstreamReply (clamd reply grammar)", () => {
  it("reads OK, FOUND, and treats anything else as a failed scan", () => {
    expect(parseInstreamReply("stream: OK")).toEqual({ verdict: "clean" });
    expect(parseInstreamReply("stream: Eicar-Test-Signature FOUND")).toEqual({ verdict: "infected", signature: "Eicar-Test-Signature" });
    expect(() => parseInstreamReply("INSTREAM size limit exceeded. ERROR")).toThrow(/error or an unrecognized reply/);
    expect(() => parseInstreamReply("")).toThrow();
  });
});

describe("ClamAvScanner against an unreachable host", () => {
  it("ping() is false and scan() rejects — never a silent 'clean'", async () => {
    const scanner = new ClamAvScanner({ host: "127.0.0.1", port: 1, timeoutMs: 3_000 });
    expect(await scanner.ping()).toBe(false);
    await expect(scanner.scan(Buffer.from("hello"))).rejects.toThrow(/unreachable|did not answer/);
  });
});

if (!CLAMD_BIN) {
  // eslint-disable-next-line no-console
  console.warn(
    "[clamav-scanner.test] CLAMD_BIN is not set — the real-clamd suite is SKIPPED. Install ClamAV and set CLAMD_BIN=/path/to/clamd to run it."
  );
}

describe.skipIf(!CLAMD_BIN)("ClamAvScanner against a REAL clamd process (EICAR-only signature database)", () => {
  let dir: string;
  let clamd: ChildProcess;
  let scanner: ClamAvScanner;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "clamd-test-"));
    // ClamAV's .ndb format: SignatureName:TargetType:Offset:HexSignature — TargetType 0 =
    // any file, Offset * = anywhere. The hex of the EICAR string, computed here, not pasted.
    writeFileSync(join(dir, "eicar.ndb"), `Eicar-Test-Signature:0:*:${EICAR.toString("hex")}\n`);
    writeFileSync(
      join(dir, "clamd.conf"),
      [
        "Foreground yes",
        `DatabaseDirectory ${dir}`,
        `LogFile ${join(dir, "clamd.log")}`,
        `PidFile ${join(dir, "clamd.pid")}`,
        // TCP only — no LocalSocket: Unix sockets aren't portable to the Windows build, and
        // TCP is the only transport the client under test speaks anyway.
        "TCPAddr 127.0.0.1",
        `TCPSocket ${PORT}`,
        "StreamMaxLength 30M",
        "LogVerbose yes",
        "",
      ].join("\n")
    );
    clamd = spawn(CLAMD_BIN as string, ["--config-file", join(dir, "clamd.conf")], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    clamd.stdout?.on("data", (c) => (output += c));
    clamd.stderr?.on("data", (c) => (output += c));

    scanner = new ClamAvScanner({ host: "127.0.0.1", port: PORT, timeoutMs: 10_000 });
    const deadline = Date.now() + 60_000; // clamd loads its DB before listening; tiny here, but be patient
    while (!(await scanner.ping())) {
      if (clamd.exitCode !== null) throw new Error(`clamd exited early (${clamd.exitCode}): ${output.slice(-800)}`);
      if (Date.now() > deadline) throw new Error(`clamd never answered PING: ${output.slice(-800)}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }, 90_000);

  afterAll(async () => {
    // Wait for clamd to actually exit — on Windows its log/pid files stay locked until it
    // does, and an immediate rmSync throws EPERM (found by running this suite on Windows).
    if (clamd && clamd.exitCode === null) {
      const exited = new Promise<void>((resolve) => clamd.once("exit", () => resolve()));
      clamd.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      // A leftover temp directory is not a test failure.
    }
  });

  it("PING/PONG over the real socket", async () => {
    expect(await scanner.ping()).toBe(true);
  });

  it("reports clean bytes as clean", async () => {
    expect(await scanner.scan(Buffer.from("This is an ordinary policy document. Nothing to see here.", "utf8"))).toEqual({ verdict: "clean" });
  });

  // ClamAV suffixes signatures that come from a custom (non-official) database with
  // ".UNOFFICIAL" — so a real clamd reports "Eicar-Test-Signature.UNOFFICIAL" here, and a
  // production clamd with the official database reports its own name for the same sample.
  // Assert the verdict and the signature's identity, not ClamAV's exact naming convention.
  it("detects the real EICAR sample streamed over INSTREAM, naming the signature", async () => {
    const result = await scanner.scan(EICAR);
    expect(result.verdict).toBe("infected");
    expect(result.verdict === "infected" && result.signature).toMatch(/Eicar-Test-Signature/);
  });

  it("detects EICAR embedded past the first chunk boundary (multi-chunk INSTREAM framing is right)", async () => {
    const filler = Buffer.alloc(200 * 1024, 0x20); // 200 KiB of spaces → EICAR lands in the 4th 64 KiB chunk
    const sample = Buffer.concat([filler, EICAR]);
    const result = await scanner.scan(sample);
    expect(result.verdict).toBe("infected");
    expect(result.verdict === "infected" && result.signature).toMatch(/Eicar-Test-Signature/);
  });

  it("handles a multi-megabyte clean payload (many chunks) without error", async () => {
    const big = Buffer.alloc(5 * 1024 * 1024, 0x41);
    expect(await scanner.scan(big)).toEqual({ verdict: "clean" });
  });
});
