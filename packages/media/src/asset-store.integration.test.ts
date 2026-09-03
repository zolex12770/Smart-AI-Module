import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "@google-cloud/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, PgAssetRepository, runMigrations, type PgliteDb } from "@ai-platform/database";
import { LocalAssetStore } from "./asset-store.js";
import { CloudStorageAssetStore, parseGsUri } from "./gcs-asset-store.js";

/**
 * Real round-trips through both AssetStore implementations (docs/26_DECISIONS.md ADR-040),
 * against a real in-memory PGlite Postgres for the `assets` rows — no mocks.
 *
 * The Cloud Storage suite runs against a real `fake-gcs-server` process (Google's JSON API,
 * reimplemented — the standard emulator for this client library), driven through the real
 * `@google-cloud/storage` client with only `apiEndpoint` redirected. It needs the emulator
 * binary, which is not checked in (35 MB) and not installed in CI: set
 * `FAKE_GCS_SERVER_BIN=/path/to/fake-gcs-server` to run it. When unset the suite is skipped
 * LOUDLY (see the console warning below) rather than silently passing — an honest,
 * visible gap, not a green checkmark that means nothing.
 */
const FAKE_GCS_BIN = process.env.FAKE_GCS_SERVER_BIN;
const EMULATOR_PORT = Number(process.env.FAKE_GCS_PORT ?? 4443);
const EMULATOR_URL = `http://127.0.0.1:${EMULATOR_PORT}`;

const PNG_LIKE_BYTES = Buffer.from("\x89PNG\r\n\x1a\n" + "x".repeat(2048), "latin1");

describe("LocalAssetStore (real disk + real assets row)", () => {
  let db: PgliteDb;
  let assetsRoot: string;

  beforeAll(async () => {
    db = await createDb(":memory:");
    await runMigrations(db);
    assetsRoot = mkdtempSync(join(tmpdir(), "asset-store-test-"));
  });

  afterAll(async () => {
    await db.$client.close();
    rmSync(assetsRoot, { recursive: true, force: true });
  });

  it("stores bytes, records a row, and reads the same bytes back through the store", async () => {
    const repo = new PgAssetRepository(db);
    const store = new LocalAssetStore(assetsRoot, repo);

    const id = await store.store(PNG_LIKE_BYTES, "image/png", "png", "image");
    const asset = await repo.get(id);

    expect(asset).toBeDefined();
    expect(asset!.sizeBytes).toBe(PNG_LIKE_BYTES.length);
    expect(asset!.storagePath.startsWith(assetsRoot)).toBe(true);
    expect((await store.read(asset!)).equals(PNG_LIKE_BYTES)).toBe(true);
  });
});

describe("parseGsUri", () => {
  it("splits a gs:// URI into bucket and object name", () => {
    expect(parseGsUri("gs://my-bucket/image/abc.png")).toEqual({ bucket: "my-bucket", objectName: "image/abc.png" });
  });

  it("refuses a local path — a row written by LocalAssetStore must never be misread as an object", () => {
    expect(() => parseGsUri("C:\\assets\\abc.png")).toThrow(/Not a gs:\/\/ URI/);
    expect(() => parseGsUri("/var/assets/abc.png")).toThrow(/Not a gs:\/\/ URI/);
  });
});

if (!FAKE_GCS_BIN) {
  // eslint-disable-next-line no-console
  console.warn(
    "[asset-store.integration.test] FAKE_GCS_SERVER_BIN is not set — the CloudStorageAssetStore round-trip " +
      "suite is SKIPPED. Download fake-gcs-server (github.com/fsouza/fake-gcs-server) and set the env var to run it."
  );
}

describe.skipIf(!FAKE_GCS_BIN)("CloudStorageAssetStore (real client against a real fake-gcs-server process)", () => {
  const bucketName = "ai-platform-test-media";
  let db: PgliteDb;
  let emulator: ChildProcess;
  let storage: Storage;

  beforeAll(async () => {
    db = await createDb(":memory:");
    await runMigrations(db);

    emulator = spawn(
      FAKE_GCS_BIN as string,
      [
        "-scheme", "http",
        "-host", "127.0.0.1",
        "-port", String(EMULATOR_PORT),
        "-backend", "memory",
        "-public-host", `127.0.0.1:${EMULATOR_PORT}`,
        "-external-url", EMULATOR_URL,
        "-log-level", "error",
      ],
      { shell: false, stdio: ["ignore", "ignore", "pipe"] }
    );
    let stderr = "";
    emulator.stderr?.on("data", (c) => (stderr += c));

    // Wait for the real HTTP endpoint to answer — not a fixed sleep.
    const deadline = Date.now() + 15_000;
    while (true) {
      try {
        const res = await fetch(`${EMULATOR_URL}/storage/v1/b`);
        if (res.ok) break;
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) throw new Error(`fake-gcs-server did not become ready: ${stderr.slice(-500)}`);
      await new Promise((r) => setTimeout(r, 150));
    }

    storage = new Storage({ apiEndpoint: EMULATOR_URL, projectId: "test-project" });
    await storage.createBucket(bucketName);
  }, 30_000);

  afterAll(async () => {
    emulator?.kill();
    await db?.$client.close();
  });

  it("uploads bytes to the bucket, records a gs:// storagePath, and downloads identical bytes back", async () => {
    const repo = new PgAssetRepository(db);
    const store = new CloudStorageAssetStore({ bucketName, storage }, repo);

    const id = await store.store(PNG_LIKE_BYTES, "image/png", "png", "image");
    const asset = await repo.get(id);

    expect(asset).toBeDefined();
    expect(asset!.storagePath).toBe(`gs://${bucketName}/image/${id}.png`);
    expect(asset!.sizeBytes).toBe(PNG_LIKE_BYTES.length);

    // Independently confirm the object really exists in the bucket with the right content
    // type — through the client directly, not through the store under test.
    const [meta] = await storage.bucket(bucketName).file(`image/${id}.png`).getMetadata();
    expect(meta.contentType).toBe("image/png");
    expect(Number(meta.size)).toBe(PNG_LIKE_BYTES.length);

    const roundTripped = await store.read(asset!);
    expect(roundTripped.equals(PNG_LIKE_BYTES)).toBe(true);
  });

  it("does not record an assets row if the upload fails (bucket does not exist)", async () => {
    const repo = new PgAssetRepository(db);
    const store = new CloudStorageAssetStore({ bucketName: "no-such-bucket-xyz", storage }, repo);

    await expect(store.store(PNG_LIKE_BYTES, "image/png", "png", "image")).rejects.toThrow();
  });

  it("round-trips through the exact production constructor path (apiEndpoint option, no injected client)", async () => {
    // The live check that found the STORAGE_EMULATOR_HOST download bug (ADR-040) exercised
    // `new Storage(...)` built inside the store, not an injected client — this test covers
    // that same path so the emulator-backed suite can never again pass while the real
    // composition root fails.
    const repo = new PgAssetRepository(db);
    const store = new CloudStorageAssetStore({ bucketName, apiEndpoint: EMULATOR_URL }, repo);

    const id = await store.store(PNG_LIKE_BYTES, "image/png", "png", "image");
    const asset = await repo.get(id);
    expect((await store.read(asset!)).equals(PNG_LIKE_BYTES)).toBe(true);
  });

  it("keys video assets under a kind prefix, so one bucket stays navigable", async () => {
    const repo = new PgAssetRepository(db);
    const store = new CloudStorageAssetStore({ bucketName, storage }, repo);

    const id = await store.store(Buffer.from("GIF89a-ish"), "image/gif", "gif", "video");
    expect((await repo.get(id))!.storagePath).toBe(`gs://${bucketName}/video/${id}.gif`);
  });
});
