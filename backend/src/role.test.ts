import { describe, expect, it } from "vitest";
import { roleRuns } from "./role.js";

describe("roleRuns (ADR-039 role decision table)", () => {
  it("'all' runs both the HTTP server and the job workers — today's local-dev topology", () => {
    expect(roleRuns("all")).toEqual({ http: true, workers: true });
  });

  it("'api' runs the HTTP server but never registers job workers", () => {
    expect(roleRuns("api")).toEqual({ http: true, workers: false });
  });

  it("'worker' registers job workers but never starts an HTTP listener", () => {
    expect(roleRuns("worker")).toEqual({ http: false, workers: true });
  });
});
