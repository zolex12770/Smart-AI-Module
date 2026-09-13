import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fromPglite, JobQueue } from "./queue.js";

/**
 * Queued work for a deleted project — docs/26_DECISIONS.md ADR-109.
 *
 * Account deletion removed the project's rows, and its queued jobs still ran: each called a paid
 * provider on behalf of an account that no longer existed, then failed at the foreign key. Real
 * pg-boss on a real PGlite, because what matters is the state pg-boss itself reports afterwards.
 */
describe("JobQueue.cancelPendingForProject", () => {
  let db: PGlite;
  let queue: JobQueue;

  beforeEach(async () => {
    db = new PGlite();
    queue = new JobQueue({ db: fromPglite(db), backend: "pglite" });
    await queue.start();
    await queue.ensureQueue("image.generate");
    await queue.ensureQueue("video.render");
  });

  afterEach(async () => {
    await queue.stop().catch(() => {});
    await db.close();
  });

  const stateOf = async (queueName: string, id: string | null) => (await queue.getJob(queueName, id as string))?.state;

  it("cancels every waiting job of one project, across queues, and nothing of another project's", async () => {
    const image = await queue.enqueue("image.generate", { projectId: "project-a" });
    const render = await queue.enqueue("video.render", { projectId: "project-a" });
    const other = await queue.enqueue("image.generate", { projectId: "project-b" });

    expect(await queue.cancelPendingForProject("project-a")).toBe(2);

    expect(await stateOf("image.generate", image)).toBe("cancelled");
    expect(await stateOf("video.render", render)).toBe("cancelled");
    expect(await stateOf("image.generate", other)).toBe("created");
  });

  it("reports zero when the project has no waiting work", async () => {
    await queue.enqueue("image.generate", { projectId: "project-b" });
    expect(await queue.cancelPendingForProject("project-a")).toBe(0);
  });
});
