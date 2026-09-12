import { connect, type Socket } from "node:net";
import type { MalwareScanner, ScanVerdict } from "./scanner.js";

export interface ClamAvScannerOptions {
  host: string;
  port?: number;
  /** Whole-scan deadline, connect included. clamd itself is fast; this guards a hung socket. */
  timeoutMs?: number;
  /** Bytes per INSTREAM chunk. clamd's protocol caps a single chunk well above this; 64 KiB
   * keeps memory flat and matches what clamdscan itself uses. */
  chunkSize?: number;
}

/**
 * A real client for clamd's TCP protocol (docs/26_DECISIONS.md ADR-042) — the same wire
 * protocol `clamdscan --stream` speaks, implemented directly rather than via an npm wrapper
 * (the popular wrappers spawn `clamdscan`/`clamscan` binaries or re-implement exactly this;
 * the protocol is ~40 lines and fully documented in clamd(8)):
 *
 *   client → `zINSTREAM\0`, then repeated `<4-byte big-endian length><chunk>`, then `<0x00000000>`
 *   clamd  → `stream: OK\0`  |  `stream: <SignatureName> FOUND\0`  |  `<message> ERROR\0`
 *
 * The `z` prefix asks clamd to NUL-terminate its reply so framing is unambiguous. Bytes go
 * over the socket only — never to a temp file — which is also what lets the tests exercise
 * a real EICAR sample without ever writing it to disk. Why TCP to a daemon and not spawning
 * `clamscan` per upload: `clamscan` reloads the whole signature database on every invocation
 * (tens of seconds); clamd keeps it resident, so a scan is milliseconds.
 */
export class ClamAvScanner implements MalwareScanner {
  readonly name: string;
  private readonly host: string;
  private readonly port: number;
  private readonly timeoutMs: number;
  private readonly chunkSize: number;

  constructor(options: ClamAvScannerOptions) {
    this.host = options.host;
    this.port = options.port ?? 3310;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.chunkSize = options.chunkSize ?? 64 * 1024;
    this.name = `clamd@${this.host}:${this.port}`;
  }

  async ping(): Promise<boolean> {
    try {
      const reply = await this.roundTrip((socket) => socket.write("zPING\0"));
      return reply === "PONG";
    } catch {
      return false;
    }
  }

  async scan(bytes: Buffer): Promise<ScanVerdict> {
    const reply = await this.roundTrip((socket) => {
      socket.write("zINSTREAM\0");
      for (let offset = 0; offset < bytes.length; offset += this.chunkSize) {
        const chunk = bytes.subarray(offset, Math.min(offset + this.chunkSize, bytes.length));
        const header = Buffer.alloc(4);
        header.writeUInt32BE(chunk.length, 0);
        socket.write(header);
        socket.write(chunk);
      }
      socket.write(Buffer.alloc(4)); // zero-length chunk terminates the stream
    });
    return parseInstreamReply(reply);
  }

  /** Opens a connection, lets `send` write the request, resolves with the NUL-terminated reply. */
  private roundTrip(send: (socket: Socket) => void): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let settled = false;
      const socket = connect({ host: this.host, port: this.port });
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        fn();
      };
      const timer = setTimeout(
        () => finish(() => reject(new Error(`clamd at ${this.host}:${this.port} did not answer within ${this.timeoutMs}ms`))),
        this.timeoutMs
      );
      socket.on("connect", () => send(socket));
      socket.on("data", (data) => {
        chunks.push(data);
        const joined = Buffer.concat(chunks);
        const nul = joined.indexOf(0);
        if (nul !== -1) finish(() => resolve(joined.subarray(0, nul).toString("utf8")));
      });
      socket.on("error", (err) => finish(() => reject(new Error(`clamd at ${this.host}:${this.port} unreachable: ${err.message}`))));
      socket.on("close", () => {
        // Reply without a NUL terminator (shouldn't happen with the z-prefix, but be safe).
        const joined = Buffer.concat(chunks).toString("utf8").trim();
        if (joined) finish(() => resolve(joined));
        else finish(() => reject(new Error(`clamd at ${this.host}:${this.port} closed the connection without replying`)));
      });
    });
  }
}

/** Exported for direct testing — the one place clamd's reply grammar is interpreted. */
export function parseInstreamReply(reply: string): ScanVerdict {
  const trimmed = reply.trim();
  if (trimmed === "stream: OK") return { verdict: "clean" };
  const found = /^stream: (.+) FOUND$/.exec(trimmed);
  if (found) return { verdict: "infected", signature: found[1] };
  // Anything else — "INSTREAM size limit exceeded. ERROR", a parse failure, an unknown
  // reply — is a scan that did NOT complete, and must never be treated as clean.
  throw new Error(`clamd returned an error or an unrecognized reply: "${trimmed}"`);
}
