import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AssetRepository } from "@ai-platform/database";
import { LocalAssetStore } from "./asset-store.js";

/**
 * No bytes without a row — docs/26_DECISIONS.md ADR-109.
 *
 * `store` writes the bytes and then inserts the `assets` row. When the insert failed — proven with a
 * job that was still running when its project's account was deleted, so the insert hit the foreign
 * key to a project that no longer existed — the file stayed on disk with no row, absent from the
 * deletion response, unfindable by anyone.
 */
describe("LocalAssetStore.store", () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("removes the bytes it wrote when the asset row cannot be inserted", async () => {
    root = mkdtempSync(join(tmpdir(), "asset-orphan-"));
    const failingRepo = {
      create: async () => {
        throw new Error('insert or update on table "assets" violates foreign key constraint');
      },
    } as unknown as AssetRepository;
    const store = new LocalAssetStore(root, failingRepo);

    await expect(store.store("deleted-project", Buffer.from("png-bytes"), "image/png", "png")).rejects.toThrow(/foreign key/);
    expect(readdirSync(root)).toEqual([]);
  });
});
