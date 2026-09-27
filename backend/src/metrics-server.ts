import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { scrapeMetrics } from "@ai-platform/observability";

/**
 * A metrics-only listener, for a process whose counters the API cannot report — found by running
 * the compose stack.
 *
 * Metrics live in each process's memory. `GET /api/v1/admin/metrics` scrapes the API process, and
 * in `ROLE=all` that is the only process, so every counter was there. Split into `api` and
 * `worker` (compose, Cloud Run) the worker does all the image, speech, video and ingestion work
 * and has no HTTP listener at all: the acceptance run read `generation_total 0` and
 * `job_processed_total 1` from the API after generating an image, a narration and a video.
 * Nothing was wrong with the counting; nothing could reach it.
 *
 * `METRICS_PORT` starts this on any role. It serves `GET /metrics` in the Prometheus text format
 * and nothing else. The labels carry no tenant data (see metrics.ts), but the port is still meant
 * for an internal network; `METRICS_TOKEN` additionally requires `Authorization: Bearer <token>`.
 */
export async function startMetricsServer(options: { port: number; host: string; token?: string }): Promise<Server> {
  const expected = options.token ? digest(`Bearer ${options.token}`) : null;
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method !== "GET" || (req.url ?? "").split("?")[0] !== "/metrics") {
        res.writeHead(404).end();
        return;
      }
      if (expected && !timingSafeEqual(digest(req.headers.authorization ?? ""), expected)) {
        res.writeHead(401, { "www-authenticate": "Bearer" }).end();
        return;
      }
      const exposition = await scrapeMetrics();
      if (exposition === null) {
        // As on the API route: an empty 200 would read as "nothing happened" rather than "not wired".
        res.writeHead(503, { "content-type": "text/plain; charset=utf-8" }).end("Metrics are not initialised in this process.\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" }).end(exposition);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolve());
  });
  return server;
}

/** Fixed-length, so `timingSafeEqual` can compare a header of any length without leaking it. */
function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
