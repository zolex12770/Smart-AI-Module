import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SYSTEM_ADMIN_ONLY_CLIENTS, SYSTEM_ADMIN_ONLY_ROUTES } from "./session-context";

/**
 * No screen may offer an action only a system administrator can take — docs/26_DECISIONS.md ADR-144.
 *
 * ADR-136 added an Enable button for MCP tools and showed it to every user. The endpoint answers
 * 404 to anyone who is not an administrator (ADR-089, because confirming an endpoint exists is
 * itself a disclosure), so an ordinary member would have pressed a real-looking button and been
 * told "Not found." Its component test passed, because a component test mocks the API and the
 * refusal lives in the API.
 *
 * A second `user?.isSystemAdmin` check would have fixed that one button and taught nobody
 * anything. This walks the whole app instead: any file that calls an admin-only client function
 * must render it inside `SystemAdminOnly`. It is a source check rather than a render check on
 * purpose — it covers screens nobody thought to write a test for, including ones added later.
 */
const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** The api client module itself DEFINES these; it is not a screen offering them. */
const DEFINITION_FILES = ["lib/api.ts", "lib/session-context.tsx"];

describe("system-admin controls are gated in the interface", () => {
  const files = sourceFiles(APP_DIR).filter(
    (f) => !DEFINITION_FILES.some((d) => relative(APP_DIR, f).split("\\").join("/") === d)
  );

  it("finds the screens under test at all", () => {
    // A walker that silently finds nothing would make every assertion below vacuous.
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((f) => f.endsWith("page.tsx"))).toBe(true);
  });

  it("renders every admin-only client call inside SystemAdminOnly", () => {
    const offenders: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const used = SYSTEM_ADMIN_ONLY_CLIENTS.filter((fn) =>
        new RegExp(`\\b${fn}\\s*\\(`).test(source)
      );
      if (used.length === 0) continue;
      if (!/SystemAdminOnly/.test(source)) {
        offenders.push(`${relative(APP_DIR, file)} calls ${used.join(", ")} without SystemAdminOnly`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("does not let a screen call an admin-only ROUTE by hand, bypassing the client", () => {
    // The client functions are the intended door. A raw `apiFetch("/api/v1/admin/...")` inside a
    // screen would sidestep both the client and this check, so the routes are matched directly.
    const offenders: string[] = [];
    const patterns = SYSTEM_ADMIN_ONLY_ROUTES.map((route) => ({
      route,
      // `/api/v1/tools/:id/enable` -> matches `/api/v1/tools/${x}/enable` and the literal path.
      regex: new RegExp(route.replace(/:[a-zA-Z]+/g, "[^\"'`]+").replace(/\//g, "\\/")),
    }));

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const { route, regex } of patterns) {
        if (!regex.test(source)) continue;
        // The platform screen reads /admin/health and handles the 404 as an expected permission
        // outcome rather than offering an action; that is a READ, not a control.
        if (route === "/api/v1/admin/health") continue;
        if (!/SystemAdminOnly/.test(source)) {
          offenders.push(`${relative(APP_DIR, file)} references ${route} without SystemAdminOnly`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("fails when a control is added without the guard", () => {
    // The check above is only worth having if it can fail. This is the same logic applied to a
    // synthetic screen that does exactly what ADR-136 did.
    const ungated = `
      import { setToolEnabled } from "../lib/api";
      export default function Bad() {
        return <button onClick={() => setToolEnabled("mcp.x", true)}>Enable</button>;
      }
    `;
    const used = SYSTEM_ADMIN_ONLY_CLIENTS.filter((fn) => new RegExp(`\\b${fn}\\s*\\(`).test(ungated));
    expect(used).toContain("setToolEnabled");
    expect(/SystemAdminOnly/.test(ungated)).toBe(false);
  });

  it("keeps the route list and the client list in step with each other", () => {
    // Neither list is derived from the other, so a route added without its client (or the
    // reverse) would leave a hole that reads as covered.
    expect(SYSTEM_ADMIN_ONLY_ROUTES.length).toBeGreaterThanOrEqual(5);
    expect(SYSTEM_ADMIN_ONLY_CLIENTS.length).toBeGreaterThanOrEqual(1);
    const apiSource = readFileSync(join(APP_DIR, "lib", "api.ts"), "utf8");
    for (const fn of SYSTEM_ADMIN_ONLY_CLIENTS) {
      expect(apiSource).toMatch(new RegExp(`export const ${fn}\\b`));
    }
  });
});
