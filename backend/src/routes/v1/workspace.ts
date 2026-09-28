import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { NotFoundError, ValidationError } from "@ai-platform/shared";
import { projectWorkspace, resolveSandboxedPath } from "@ai-platform/tools";
import type { AppContext } from "../../context.js";
import { requireProject } from "../../plugins/auth.js";

/**
 * Putting files where the agent can reach them — docs/26_DECISIONS.md ADR-142.
 *
 * The coding agent works inside a per-project workspace (`projectWorkspace`) and holds the tools
 * to read, write, search and run commands in it. Nothing could put anything INTO it. The complete
 * list of routes contained no workspace, repo, clone or upload-to-workspace path, and the Files
 * screen's upload writes to the ASSET STORE — a different place, which the filesystem tools cannot
 * see. So "fix the failing test" had no test to fix: the agent's first action was always to
 * discover an empty directory, and a capability the product documents could not be started.
 *
 * WHY WRITING FILES RATHER THAN CLONING A REPOSITORY. `git clone` from a model-driven agent's
 * environment means outbound network access to an arbitrary URL, credential handling for private
 * repositories, and an unbounded amount of data landing on disk — three security decisions, each
 * larger than this one. Writing named files is the smaller, honest primitive: it seeds a workspace
 * for a coding task, it is bounded and containment-checked, and it does not pretend to be a VCS
 * integration. `docs/27_RISKS_AND_LIMITATIONS.md` records that cloning is deliberately absent.
 *
 * Every path goes through `resolveSandboxedPath` (ADR-088, ADR-125), which is the same check the
 * agent's own tools use — a request naming `../../etc/passwd` is refused here exactly as it is
 * refused there, and the refusal does not echo where the path resolved to.
 */
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_LISTED_FILES = 500;

const writeFileRequestSchema = z.object({
  /** Relative to the project's workspace root. Absolute paths and `..` are refused by the check. */
  path: z.string().min(1).max(500),
  content: z.string().max(MAX_FILE_BYTES),
});

/**
 * A containment refusal is the CALLER's mistake, so it answers 4xx — ADR-142.
 *
 * `resolveSandboxedPath` throws a plain `Error`, which the API's error handler maps to a 500
 * INTERNAL_ERROR: the server telling the client that the server broke, when in fact the request
 * asked for something it is not allowed to ask for. Rethrown as a validation error, which is what
 * it is. The message is passed through unchanged — it deliberately does not name the destination
 * the path resolved to (ADR-088), and rewriting it here would risk losing that.
 */
function resolveInWorkspace(root: string, requested: string): string {
  try {
    return resolveSandboxedPath(root, requested);
  } catch (error) {
    throw new ValidationError(error instanceof Error ? error.message : String(error));
  }
}

export function registerWorkspaceRoutes(app: FastifyInstance, ctx: AppContext): void {
  /**
   * What is in the workspace right now.
   *
   * Reads through the real directory rather than a database table, because the filesystem is the
   * source of truth here: the agent writes to it directly, and a listing from anywhere else would
   * drift the moment a task ran.
   */
  app.get("/api/v1/workspace/files", async (request) => {
    const authCtx = await requireProject(request, ctx.auth, "project:read");
    const root = projectWorkspace(ctx.sandboxRoot, { projectId: authCtx.projectId! });

    const files: Array<{ path: string; sizeBytes: number; modifiedAt: string }> = [];
    async function walk(dir: string): Promise<void> {
      if (files.length >= MAX_LISTED_FILES) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return; // a workspace that has never been written to is an empty one, not an error
      }
      for (const entry of entries) {
        if (files.length >= MAX_LISTED_FILES) return;
        const absolute = join(dir, entry.name);
        // `isDirectory()` on the DirEntry, which does not follow links: a symlink inside the
        // workspace must not make this walk leave it (ADR-088).
        if (entry.isDirectory()) {
          await walk(absolute);
        } else if (entry.isFile()) {
          const info = await stat(absolute).catch(() => null);
          if (!info) continue;
          files.push({
            path: relative(root, absolute).split(sep).join("/"),
            sizeBytes: info.size,
            modifiedAt: info.mtime.toISOString(),
          });
        }
      }
    }
    await walk(root);

    files.sort((a, b) => a.path.localeCompare(b.path));
    return { files, truncated: files.length >= MAX_LISTED_FILES };
  });

  /** One file's contents, for confirming what the agent will actually see. */
  app.get<{ Querystring: { path?: string } }>("/api/v1/workspace/file", async (request) => {
    const authCtx = await requireProject(request, ctx.auth, "project:read");
    const requested = request.query.path;
    if (!requested) throw new ValidationError("A `path` query parameter is required.");

    const root = projectWorkspace(ctx.sandboxRoot, { projectId: authCtx.projectId! });
    const absolute = resolveInWorkspace(root, requested);
    const info = await stat(absolute).catch(() => null);
    if (!info?.isFile()) throw new NotFoundError(`No file "${requested}" in this project's workspace.`);
    if (info.size > MAX_FILE_BYTES) {
      throw new ValidationError(`"${requested}" is larger than the ${MAX_FILE_BYTES}-byte view limit.`);
    }
    return { path: requested, content: await readFile(absolute, "utf8") };
  });

  /**
   * Writes one file into the workspace.
   *
   * `project:write`, not `project:read`: this changes what an agent will act on, which is the
   * same authority as creating the work. Rate-limited per user — seeding a workspace is a handful
   * of files, and an unbounded loop here is a way to fill a disk.
   */
  app.post(
    "/api/v1/workspace/files",
    {
      // Audit finding 26: the schema allows a 1 MiB file, and Fastify's default 1 MiB body limit
      // refused one with 413 before the schema ever ran — the JSON envelope, and escaping (up to
      // six bytes per character for `\u0000`), make the body larger than the file it carries.
      bodyLimit: 6 * MAX_FILE_BYTES + 4096,
      config: {
        rateLimit: {
          max: 120,
          timeWindow: "10 minutes",
          hook: "preHandler",
          keyGenerator: (req: FastifyRequest) => req.auth?.user.id ?? req.ip,
        },
      },
    },
    async (request, reply) => {
      const authCtx = await requireProject(request, ctx.auth, "project:write");
      const parsed = writeFileRequestSchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError(parsed.error.message);

      const root = projectWorkspace(ctx.sandboxRoot, { projectId: authCtx.projectId! });
      // Containment first, always: the same helper the agent's own tools use, so this route
      // cannot become a way around the boundary they enforce.
      const absolute = resolveInWorkspace(root, parsed.data.path);
      // The parent is created because seeding a project means creating directories, and the
      // resolved path is already known to be inside the workspace.
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, parsed.data.content, "utf8");

      reply.status(201).send({
        file: { path: parsed.data.path, sizeBytes: Buffer.byteLength(parsed.data.content, "utf8") },
      });
    }
  );
}
