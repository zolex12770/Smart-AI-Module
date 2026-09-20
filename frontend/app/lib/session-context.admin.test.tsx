import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SYSTEM_ADMIN_ONLY_CLIENTS, SYSTEM_ADMIN_ONLY_ROUTES } from "./session-context";

/**
 * No screen may offer an action only a system administrator can take — docs/26_DECISIONS.md
 * ADR-144, strengthened by ADR-152.
 *
 * ADR-136 added an Enable button for MCP tools and showed it to every user. The endpoint answers
 * 404 to anyone who is not an administrator (ADR-089, because confirming an endpoint exists is
 * itself a disclosure), so an ordinary member would have pressed a real-looking button and been
 * told "Not found." Its component test passed, because a component test mocks the API and the
 * refusal lives in the API.
 *
 * The first version of this file asked only whether the string "SystemAdminOnly" appeared
 * ANYWHERE in a file that calls an admin-only client. In `tasks/page.tsx` the call is at line 190
 * and the guard at 235; in `platform/page.tsx` the call is at 150 and the guard at 256. Neither
 * relationship was checked, so a screen could have held a guard around one control and offered a
 * second, ungated one — which is the exact defect, one line apart. It checks CONTAINMENT now: the
 * control that triggers the call must sit inside a guarded region.
 */
const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The api client module itself DEFINES these; it is not a screen offering them. */
const DEFINITION_FILES = ["lib/api.ts", "lib/session-context.tsx"];

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

/** Character ranges covered by a `<SystemAdminOnly …>…</SystemAdminOnly>` element. */
function guardedRegions(source: string): Array<[number, number]> {
  const regions: Array<[number, number]> = [];
  const open = /<SystemAdminOnly\b/g;
  let match: RegExpExecArray | null;
  while ((match = open.exec(source)) !== null) {
    const start = match.index;
    // Self-closing guards wrap nothing, so they are deliberately not a region.
    const close = source.indexOf("</SystemAdminOnly>", start);
    if (close === -1) continue;
    regions.push([start, close + "</SystemAdminOnly>".length]);
  }
  return regions;
}

const inside = (regions: Array<[number, number]>, index: number) =>
  regions.some(([from, to]) => index >= from && index < to);

/**
 * The real check, exported so the "can this fail" case below runs THIS function rather than a
 * re-implementation of it. A regression in the walker is otherwise invisible: the previous
 * version's negative case re-implemented the check inline and passed while the walker itself was
 * doing something weaker.
 */
export function ungatedAdminControls(relativePath: string, source: string): string[] {
  const problems: string[] = [];
  const regions = guardedRegions(source);

  for (const fn of SYSTEM_ADMIN_ONLY_CLIENTS) {
    const call = new RegExp(`\\b${fn}\\s*\\(`, "g");
    let match: RegExpExecArray | null;
    while ((match = call.exec(source)) !== null) {
      // The call itself is usually in a handler at the top of the component, which is fine —
      // what matters is where the CONTROL that reaches it is rendered. A call that is already
      // inside a guard is fine either way.
      if (inside(regions, match.index)) continue;

      // Find the enclosing handler's name, and check every JSX reference to it.
      const before = source.slice(0, match.index);
      const declaration = [...before.matchAll(/(?:function|const)\s+(\w+)\s*(?=[=(])/g)].pop();
      const handler = declaration?.[1];
      if (!handler) {
        problems.push(`${relativePath}: ${fn}() is called outside any named handler and outside SystemAdminOnly`);
        continue;
      }

      const usage = new RegExp(`on[A-Z]\\w*=\\{[^}]*\\b${handler}\\b`, "g");
      const references = [...source.matchAll(usage)];
      if (references.length === 0) {
        problems.push(`${relativePath}: ${handler}() calls ${fn}() and no control references it`);
        continue;
      }
      for (const reference of references) {
        if (!inside(regions, reference.index)) {
          problems.push(`${relativePath}: a control calling ${handler}() (${fn}) is rendered outside SystemAdminOnly`);
        }
      }
    }
  }
  return problems;
}

describe("system-admin controls are gated in the interface", () => {
  const files = sourceFiles(APP_DIR).filter(
    (f) => !DEFINITION_FILES.some((d) => relative(APP_DIR, f).split("\\").join("/") === d)
  );

  it("finds the screens under test at all", () => {
    // A walker that silently finds nothing would make every assertion below vacuous.
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((f) => f.endsWith("page.tsx"))).toBe(true);
  });

  it("renders every admin-only control inside SystemAdminOnly", () => {
    const offenders = files.flatMap((file) =>
      ungatedAdminControls(relative(APP_DIR, file).split("\\").join("/"), readFileSync(file, "utf8"))
    );
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
    // The REAL walker, against a fixture that does exactly what ADR-136 did. The previous
    // version of this case re-implemented the check inline, so it proved nothing about the
    // function the assertion above depends on.
    const ungated = `
      import { setToolEnabled } from "../lib/api";
      export default function Bad() {
        const enable = async () => { await setToolEnabled("mcp.x", true); };
        return <button onClick={enable}>Enable</button>;
      }
    `;
    expect(ungatedAdminControls("bad.tsx", ungated)).toHaveLength(1);
    expect(ungatedAdminControls("bad.tsx", ungated)[0]).toMatch(/outside SystemAdminOnly/);
  });

  it("fails when a second control is added beside a guarded one", () => {
    // The shape the old string check could not see: a file that HAS a guard, around a different
    // control, and offers an ungated one next to it.
    const halfGated = `
      import { setToolEnabled, reconnectMcpServer } from "../lib/api";
      export default function Half() {
        const enable = async () => { await setToolEnabled("mcp.x", true); };
        const reconnect = async () => { await reconnectMcpServer("s1"); };
        return (
          <div>
            <SystemAdminOnly><button onClick={enable}>Enable</button></SystemAdminOnly>
            <button onClick={reconnect}>Reconnect</button>
          </div>
        );
      }
    `;
    const problems = ungatedAdminControls("half.tsx", halfGated);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/reconnect/);
  });

  it("accepts a control that really is inside the guard", () => {
    // A check that rejects everything is indistinguishable from a broken one.
    const gated = `
      import { setToolEnabled } from "../lib/api";
      export default function Good() {
        const enable = async () => { await setToolEnabled("mcp.x", true); };
        return <SystemAdminOnly><button onClick={enable}>Enable</button></SystemAdminOnly>;
      }
    `;
    expect(ungatedAdminControls("good.tsx", gated)).toEqual([]);
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
