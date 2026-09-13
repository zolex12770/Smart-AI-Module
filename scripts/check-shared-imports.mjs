#!/usr/bin/env node
/**
 * Boundary check 2, as a parser — docs/26_DECISIONS.md ADR-092, ADR-106.
 *
 * The frontend may import `shared` for TYPES ONLY. A value import would pull zod and the error
 * classes into the browser bundle and turn a contract into a runtime dependency.
 *
 * WHY THIS IS NOT A GREP. It was, twice, and both versions could not fail:
 *
 *  1. The first anchored with `^` inside an ERE alternation group, which does not anchor, so it
 *     matched nothing and reported a pass.
 *  2. The replacement was `grep "@ai-platform/shared" | grep -E "import|require" | grep -v
 *     "import type"`. In a MULTI-LINE import the only line naming the package is
 *     `} from "@ai-platform/shared";` — which contains neither `import` nor `require`, so the
 *     second filter discarded the one line that mattered. A real value import split across lines
 *     passed, proven by planting one. `export { x } from "@ai-platform/shared"` was invisible for
 *     the same reason.
 *
 * A statement that spans lines cannot be judged by a tool that reads one line at a time, so this
 * normalises whitespace and matches the whole statement. An import is type-only when the entire
 * statement is `import type ...`, or when every named binding carries an inline `type` prefix.
 *
 * Reads file paths on stdin, one per line. Prints each violation; exits 0 either way — the shell
 * script decides what a violation means, so this stays a reporter rather than a gate.
 */
import { readFileSync } from "node:fs";

const PACKAGE = "@ai-platform/shared";
const STATEMENT = /(import|export)\s+([^;]*?)\s*from\s*["']@ai-platform\/shared["']/g;

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  const violations = [];

  for (const file of input.split(/\r?\n/).filter(Boolean)) {
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (!source.includes(PACKAGE)) continue;

    const flattened = source.replace(/\s+/g, " ");
    for (const match of flattened.matchAll(STATEMENT)) {
      const clause = match[2].trim();

      // `import type { A, B } from "..."` and `import type Default from "..."`.
      if (/^type\b/.test(clause)) continue;

      // `import { type A, type B } from "..."` — every binding individually type-only.
      const named = /\{([^}]*)\}/.exec(clause);
      if (named) {
        const bindings = named[1]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (bindings.length > 0 && bindings.every((b) => /^type\s/.test(b))) continue;
      }

      violations.push(`${file}: ${match[0].slice(0, 140)}`);
    }
  }

  if (violations.length > 0) process.stdout.write(violations.join("\n") + "\n");
});
