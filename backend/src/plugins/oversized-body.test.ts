import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import type { PgliteDb } from "@ai-platform/database";
import { buildTestApp, closeTestApp } from "../test-app.js";
import type { AppContext } from "../context.js";

/**
 * DL-26 — an oversized upload must be answered, not reset.
 *
 * The attack suite, run on the final image, saw "connection closed without a response" for an
 * 8 MiB POST. The server sent 413 as soon as it saw the size and closed with the rest of the
 * upload unread; that close went out as a TCP RST, and the client's kernel discarded the 413.
 * Against the built server: 12 of 20 keep-alive uploads and 18 of 20 `Connection: close`
 * uploads lost their answer. A user uploading a file that is too large saw a network error
 * instead of "too large".
 *
 * Only a real socket shows this (`inject` has none), and only with the client in ANOTHER process:
 * in one process the client's writes and the server's reads share an event loop, and the race
 * never happens.
 */
const CLIENT = `
const { connect } = require("node:net");
const [port, tries, mode] = process.argv.slice(1).map((v, i) => (i < 2 ? Number(v) : v));
const once = () => new Promise((resolve) => {
  const socket = connect({ host: "127.0.0.1", port });
  let received = "", settled = false;
  const settle = (v) => { if (!settled) { settled = true; socket.destroy(); resolve(v); } };
  socket.on("data", (c) => { received += c.toString("latin1"); const m = /^HTTP\\/1\\.1 (\\d{3})/.exec(received); if (m) settle(m[1]); });
  socket.on("error", () => setTimeout(() => settle(received ? "unparseable" : "reset"), 50));
  socket.on("close", () => settle(received ? "unparseable" : "reset"));
  socket.once("connect", async () => {
    const bytes = 8 * 1024 * 1024;
    socket.write("POST /api/v1/memory HTTP/1.1\\r\\nHost: 127.0.0.1\\r\\ncontent-type: application/json\\r\\ncontent-length: " + bytes + "\\r\\n" + (mode === "close" ? "connection: close\\r\\n" : "") + "\\r\\n");
    const chunk = Buffer.alloc(64 * 1024, "x");
    for (let sent = 0; sent < bytes && !settled && !socket.destroyed; sent += chunk.length) {
      if (!socket.write(chunk)) await new Promise((r) => socket.once("drain", r).once("close", r));
    }
  });
});
(async () => { const out = []; for (let i = 0; i < tries; i++) out.push(await once()); console.log(out.join(" ")); })();
`;

describe("an oversized body over a real connection", () => {
  let app: FastifyInstance;
  let db: PgliteDb;
  let ctx: AppContext;
  let port: number;

  beforeEach(async () => {
    ({ app, db, ctx } = await buildTestApp());
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await closeTestApp(app, db, ctx);
  });

  const statuses = async (mode: "keep-alive" | "close") => {
    const { stdout } = await promisify(execFile)(process.execPath, ["-e", CLIENT, String(port), "15", mode], { timeout: 50_000 });
    return stdout.trim().split(" ");
  };

  it("answers every oversized keep-alive upload with 413, never a reset", async () => {
    expect((await statuses("keep-alive")).filter((s) => s !== "413")).toEqual([]);
  }, 60_000);

  it("answers every oversized `Connection: close` upload with 413, never a reset", async () => {
    expect((await statuses("close")).filter((s) => s !== "413")).toEqual([]);
  }, 60_000);
});
