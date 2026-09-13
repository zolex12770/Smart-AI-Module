#!/usr/bin/env node
/**
 * Frontend/backend boundary verification, as a parser — docs/26_DECISIONS.md ADR-092, ADR-111.
 *
 * WHY THIS IS NOT A SHELL SCRIPT OF GREPS ANY MORE. Every grep-based check in the old
 * verify-boundary.sh was eventually shown to be defeatable, and three of them could not fail at all:
 *
 *  - check 2 anchored with `^` inside an ERE alternation group (matched nothing), then missed a
 *    multi-line import (the package name sits on the `} from` line), then — as a regex over flattened
 *    text — was fooled by a comment containing "import type", a default binding before `{ type X }`,
 *    a semicolon-free file, `import()`, `require()` and a side-effect import;
 *  - check 6 passed `-E` and `-P` together, which grep rejects outright, so it was always green;
 *  - checks 1, 4 and 5 matched only a double-quoted static `from "..."`, so single quotes and dynamic
 *    `import()` passed; check 3 missed `node:fs/promises`, bare `fs` and `child_process`; check 5
 *    missed a bare `../../shared` and the `@/../shared` alias; check 6 saw only `process.env.X` and
 *    missed `process.env["X"]` and destructuring; no check read `.js`, `.jsx`, `.mjs` or `.cjs`;
 *  - check 7 only tested that a package.json existed, and passed while backend/src imported a
 *    package its manifest did not declare.
 *
 * A module specifier is a property of the syntax tree, not of a line of text, so this reads the
 * syntax tree with the TypeScript compiler (already a dependency). Comments are not in the tree,
 * statements are delimited by the parser, and every import form is a distinct node kind.
 *
 * AND IT PROVES IT CAN FAIL. `--self-test` builds a throwaway repository containing every evasion
 * listed above, plus clean code, and requires every planted violation to be reported under the right
 * rule and nothing in the clean files. `--all` runs the self-test and then the real check; a checker
 * that cannot detect its own fixtures never gets to report the real tree green.
 *
 * SCOPE. Rules 2 and 3 protect the BROWSER BUNDLE, so they apply to frontend application code and not
 * to unit tests, end-to-end specs or build configuration, none of which is ever bundled (a Playwright
 * spec may legitimately read a fixture file). Rule 6 is about secrets, and applies to every frontend
 * file. Rule 7 applies to every package manifest in the tree, not only the three applications: an
 * undeclared import resolves only because npm hoisted another package's dependency, and it breaks the
 * day that dependency moves — widening it found `uuid` imported by quota's tests and never declared.
 *
 * Exit codes: 0 clean, 1 violations (or a failed self-test), 2 the checker itself broke. An internal
 * error is never reported as a pass.
 */
import ts from "typescript";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIPPED_DIRECTORIES = new Set([
  "node_modules", "dist", ".next", "coverage", "test-results", "playwright-report", "data", ".turbo", "build",
]);

const BACKEND_PACKAGE = /^@ai-platform\/(agent-core|database|embeddings|jobs|mcp|media|memory|model-router|observability|quota|rag|scanning|security|tools|api|llm-[a-z]+|image-[a-z]+|video-[a-z]+)(\/|$)/;
const SHARED_PACKAGE = /^@ai-platform\/shared(\/|$)/;
const INFRASTRUCTURE = /^(?:(?:node:)?(?:fs|child_process|net|tls|dgram|cluster|worker_threads)|drizzle-orm|pg|pg-boss|@electric-sql\/pglite)(?:\/.*)?$/;
const FRONTEND_ONLY = /^(?:react|react-dom|next)(?:\/.*)?$|^@ai-platform\/web(?:\/|$)/;
const PUBLIC_ENV = /^(?:NEXT_PUBLIC_[A-Z0-9_]*|NODE_ENV|CI|E2E_[A-Z0-9_]*|PLAYWRIGHT_[A-Z0-9_]*)$/;
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

export const RULES = [
  [1, "frontend imports no backend package"],
  [2, "every frontend import of shared/ is type-only"],
  [3, "frontend application code reaches no database, queue, filesystem or subprocess"],
  [4, "backend imports nothing from the frontend"],
  [5, "no relative or aliased import crosses an application boundary"],
  [6, "no frontend file — application, test or end-to-end spec — reads a server-side environment variable"],
  [7, "every package in the tree declares every package it imports"],
];

function scriptKindFor(file) {
  switch (path.extname(file)) {
    case ".tsx": return ts.ScriptKind.TSX;
    case ".jsx": return ts.ScriptKind.JSX;
    case ".js": case ".mjs": case ".cjs": return ts.ScriptKind.JS;
    default: return ts.ScriptKind.TS;
  }
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (SKIPPED_DIRECTORIES.has(entry)) continue;
    const full = path.join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) walk(full, out);
    else if (SOURCE_EXTENSIONS.has(path.extname(entry)) && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** Every use of a module specifier in a file, with whether it can only ever be erased. */
function moduleUses(sf) {
  const uses = [];
  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const literal = (node) => (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null);

  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      let typeOnly = false;
      if (clause) {
        if (clause.isTypeOnly) typeOnly = true;
        else if (
          !clause.name &&
          clause.namedBindings &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.length > 0 &&
          clause.namedBindings.elements.every((e) => e.isTypeOnly)
        ) typeOnly = true;
      }
      uses.push({ spec: literal(node.moduleSpecifier), typeOnly, form: clause ? "import" : "side-effect import", line: lineOf(node) });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const clause = node.exportClause;
      const typeOnly =
        node.isTypeOnly ||
        (!!clause && ts.isNamedExports(clause) && clause.elements.length > 0 && clause.elements.every((e) => e.isTypeOnly));
      uses.push({ spec: literal(node.moduleSpecifier), typeOnly, form: "re-export", line: lineOf(node) });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      uses.push({ spec: literal(node.moduleReference.expression), typeOnly: node.isTypeOnly, form: "import = require", line: lineOf(node) });
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        uses.push({ spec: literal(node.arguments[0]), typeOnly: false, form: "dynamic import()", line: lineOf(node) });
      } else if (ts.isIdentifier(node.expression) && node.expression.text === "require" && node.arguments.length > 0) {
        uses.push({ spec: literal(node.arguments[0]), typeOnly: false, form: "require()", line: lineOf(node) });
      }
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      uses.push({ spec: literal(node.argument.literal), typeOnly: true, form: "import type node", line: lineOf(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return uses;
}

/** Every access to `process.env`, and whether it is a dotted or literal-bracket read of one name. */
function envUses(sf) {
  const found = [];
  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const isProcessEnv = (node) =>
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "env" &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "process";
  const visit = (node) => {
    if (isProcessEnv(node)) {
      const parent = node.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        found.push({ name: parent.name.text, line: lineOf(node) });
      } else if (ts.isElementAccessExpression(parent) && parent.expression === node) {
        const arg = parent.argumentExpression;
        found.push(
          ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)
            ? { name: arg.text, line: lineOf(node) }
            : { name: null, detail: "computed process.env[...] access", line: lineOf(node) }
        );
      } else {
        found.push({ name: null, detail: "process.env used as a whole value (destructuring, aliasing or spreading)", line: lineOf(node) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function packageNameOf(spec) {
  if (spec.startsWith("@")) return spec.split("/").slice(0, 2).join("/");
  return spec.split("/")[0];
}

function isWithin(child, parent) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Frontend code a browser bundle can reach: not tests, not end-to-end specs, not build tooling. */
function isFrontendApplicationCode(rel) {
  const p = rel.split(path.sep).join("/");
  if (p.startsWith("frontend/e2e/") || p.startsWith("frontend/test/")) return false;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(p)) return false;
  if (/^frontend\/[^/]+\.config\.[cm]?[jt]s$/.test(p)) return false;
  return true;
}

export function checkRepository(root) {
  root = path.resolve(root);
  const apps = {
    frontend: path.join(root, "frontend"),
    backend: path.join(root, "backend"),
    shared: path.join(root, "shared"),
  };
  const violations = [];
  let scanned = 0;

  const manifests = new Map();
  const declaredFor = (dir) => {
    if (!manifests.has(dir)) {
      const manifestPath = path.join(dir, "package.json");
      if (!existsSync(manifestPath)) {
        manifests.set(dir, null);
      } else {
        const m = JSON.parse(readFileSync(manifestPath, "utf8"));
        manifests.set(dir, new Set([
          ...Object.keys(m.dependencies ?? {}),
          ...Object.keys(m.devDependencies ?? {}),
          ...Object.keys(m.peerDependencies ?? {}),
          ...Object.keys(m.optionalDependencies ?? {}),
          m.name,
        ]));
      }
    }
    return manifests.get(dir);
  };
  for (const [name, dir] of Object.entries(apps)) {
    if (existsSync(dir) && !existsSync(path.join(dir, "package.json"))) {
      violations.push({ rule: 7, file: path.join(name, "package.json"), line: 0, detail: "the application has no package.json of its own" });
    }
  }
  const nearestManifestDir = (file) => {
    let dir = path.dirname(file);
    while (isWithin(dir, root) && dir !== root) {
      if (existsSync(path.join(dir, "package.json"))) return dir;
      dir = path.dirname(dir);
    }
    return null;
  };

  for (const [appName, appDir] of Object.entries(apps)) {
    for (const file of walk(appDir)) {
      scanned++;
      const rel = path.relative(root, file);
      const source = readFileSync(file, "utf8"); // unreadable -> throws -> exit 2, never a pass
      const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindFor(file));
      const appCode = appName === "frontend" && isFrontendApplicationCode(rel);
      const manifestDir = nearestManifestDir(file);
      const checksDependencies = manifestDir !== null;

      for (const use of moduleUses(sf)) {
        const at = { file: rel, line: use.line };
        if (use.spec === null) {
          if (appName === "frontend") violations.push({ rule: 1, ...at, detail: `${use.form} with a computed specifier cannot be verified` });
          continue;
        }
        const spec = use.spec;

        if (appName === "frontend") {
          if (BACKEND_PACKAGE.test(spec)) violations.push({ rule: 1, ...at, detail: `${use.form} of ${spec}` });
          if (appCode && SHARED_PACKAGE.test(spec) && !use.typeOnly) violations.push({ rule: 2, ...at, detail: `${use.form} of ${spec} is not type-only` });
          if (appCode && INFRASTRUCTURE.test(spec)) violations.push({ rule: 3, ...at, detail: `${use.form} of ${spec}` });
        }
        if (appName === "backend" && FRONTEND_ONLY.test(spec)) {
          violations.push({ rule: 4, ...at, detail: `${use.form} of ${spec}` });
        }

        let target = null;
        if (spec.startsWith(".")) target = path.resolve(path.dirname(file), spec);
        else if (appName === "frontend" && spec.startsWith("@/")) target = path.resolve(apps.frontend, spec.slice(2));
        if (target !== null) {
          // The one sanctioned exception: every package's vitest config extends the repo-root base
          // config for shared timeouts. That is test tooling reaching tooling, not application code.
          const toolingBase = path.dirname(target) === root && /^vitest\.config\.base(\.[cm]?[jt]s)?$/.test(path.basename(target));
          if (!toolingBase && !isWithin(target, appDir)) {
            violations.push({ rule: 5, ...at, detail: `${use.form} of "${spec}" resolves outside ${appName}/` });
          }
          continue;
        }

        if (spec.startsWith("@/") || BUILTINS.has(spec) || BUILTINS.has(spec.split("/")[0])) continue;
        if (checksDependencies) {
          const declared = declaredFor(manifestDir);
          const pkg = packageNameOf(spec);
          if (declared && !declared.has(pkg)) {
            violations.push({ rule: 7, ...at, detail: `imports "${pkg}", which ${path.relative(root, manifestDir) || "."}/package.json does not declare` });
          }
        }
      }

      if (appName === "frontend") {
        for (const env of envUses(sf)) {
          if (env.name === null) violations.push({ rule: 6, file: rel, line: env.line, detail: env.detail });
          else if (!PUBLIC_ENV.test(env.name)) violations.push({ rule: 6, file: rel, line: env.line, detail: `reads process.env.${env.name}` });
        }
      }
    }
  }
  return { violations, scanned };
}

// ---------------------------------------------------------------------------------------------
// self-test: every known evasion must be caught, and clean code must not be
// ---------------------------------------------------------------------------------------------
const FIXTURES = {
  "package.json": `{"name":"fixture-root","private":true}`,
  "vitest.config.base.ts": `export const TEST_TIMEOUTS = { testTimeout: 1 };`,
  "frontend/package.json": `{"name":"@ai-platform/web","dependencies":{"@ai-platform/shared":"*","next":"*","react":"*"},"devDependencies":{"@playwright/test":"*","vitest":"*"}}`,
  "backend/package.json": `{"name":"@ai-platform/api","dependencies":{"fastify":"*","@ai-platform/shared":"*"},"devDependencies":{"vitest":"*"}}`,
  "shared/package.json": `{"name":"@ai-platform/shared","dependencies":{"zod":"*"}}`,

  // ---- clean: none of these may be reported ----
  "frontend/app/clean.tsx": `import type { A } from "@ai-platform/shared";
import { type B, type C } from "@ai-platform/shared";
import type {
  D,
  E,
} from "@ai-platform/shared";
export type { F } from "@ai-platform/shared";
import React from "react";
import { useRouter } from "next/navigation";
import { helper } from "@/app/lib/helper";
export const api = process.env.NEXT_PUBLIC_API_URL;
export const mode = process.env.NODE_ENV;
export const quoted = process.env["NEXT_PUBLIC_FLAG"];
// import { createDb } from "@ai-platform/database";  <- a comment, not an import
export default function Page() { return React.createElement("div", null, String(useRouter) + helper + api + mode); }`,
  "frontend/app/lib/helper.ts": `export const helper = "ok";`,
  "frontend/e2e/spec.ts": `import { test } from "@playwright/test";
import { spawnSync } from "node:child_process";
export const chromium = process.env.PLAYWRIGHT_CHROMIUM_PATH;
test("x", () => { spawnSync("true"); });`,
  "frontend/vitest.config.ts": `import { TEST_TIMEOUTS } from "../vitest.config.base.js";
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { ...TEST_TIMEOUTS } });`,
  "backend/src/clean.ts": `import Fastify from "fastify";
import type { X } from "@ai-platform/shared";
import { readFileSync } from "node:fs";
import path from "path";
export const app = Fastify; export type Y = X; export const r = readFileSync; export const p = path;`,
  "backend/vitest.config.ts": `import { TEST_TIMEOUTS } from "../vitest.config.base.js";
export default { test: { ...TEST_TIMEOUTS } };`,
  "shared/src/index.ts": `import { z } from "zod"; export const s = z.string();`,

  "backend/packages/widget/package.json": `{"name":"@ai-platform/widget","dependencies":{"zod":"*"}}`,
  "backend/packages/widget/src/clean-widget.ts": `import { z } from "zod"; import { readFileSync } from "node:fs"; export const w = [z, readFileSync];`,

  // ---- rule 1 ----
  "frontend/app/r1-single-quote.ts": `import { createDb } from '@ai-platform/database'; export const x = createDb;`,
  "frontend/app/r1-dynamic.ts": `export const load = () => import("@ai-platform/database");`,
  "frontend/app/r1-require.js": `const tools = require("@ai-platform/tools"); module.exports = tools;`,
  "frontend/app/r1-jsx.jsx": `import { hashPassword } from "@ai-platform/security"; export default function X() { return hashPassword; }`,
  "frontend/app/r1-subpath.ts": `import { y } from "@ai-platform/media/dist/index.js"; export const z = y;`,
  "frontend/app/r1-reexport.ts": `export { createDb } from "@ai-platform/database";`,

  // ---- rule 2 ----
  "frontend/app/r2-comment-then-value.ts": `// Contracts come in via import type, never as values.
import { ChatRequestSchema } from "@ai-platform/shared";
export const s = ChatRequestSchema;`,
  "frontend/app/r2-default-plus-type.ts": `import Shared, { type ChatRequest } from "@ai-platform/shared"; export const s: ChatRequest = Shared;`,
  "frontend/app/r2-dynamic.ts": `export const s = await import("@ai-platform/shared");`,
  "frontend/app/r2-require.cjs": `module.exports = require("@ai-platform/shared");`,
  "frontend/app/r2-side-effect.ts": `import "@ai-platform/shared";`,
  "frontend/app/r2-no-semicolons.ts": `import type { Task } from "./types"
import { ApiError } from "@ai-platform/shared"
export const e: Task = ApiError`,
  "frontend/app/types.ts": `export type Task = unknown;`,
  "frontend/app/r2-multiline.ts": `import {
  chatRequestSchema,
} from "@ai-platform/shared";
export const s = chatRequestSchema;`,
  "frontend/app/r2-reexport.ts": `export { chatRequestSchema } from "@ai-platform/shared";`,
  "frontend/app/r2-namespace.ts": `import * as Shared from "@ai-platform/shared"; export const s = Shared;`,
  "frontend/app/r2-mjs.mjs": `import { ApiError } from "@ai-platform/shared"; export const e = ApiError;`,

  // ---- rule 3 ----
  "frontend/app/r3-fs-promises.ts": `import { readFile } from "node:fs/promises"; export const r = readFile;`,
  "frontend/app/r3-bare-fs.ts": `import { writeFileSync } from "fs"; export const w = writeFileSync;`,
  "frontend/app/r3-child-process.ts": `import { spawn } from "child_process"; export const s = spawn;`,
  "frontend/app/r3-pg-single-quote.ts": `import pg from 'pg'; export const p = pg;`,

  // ---- rule 4 ----
  "backend/src/r4-react-single.ts": `import React from 'react'; export const r = React;`,
  "backend/src/r4-next-server.ts": `import { NextResponse } from "next/server"; export const n = NextResponse;`,
  "backend/src/r4-dynamic.ts": `export const r = () => import("react");`,

  // ---- rule 5 ----
  "frontend/app/r5-backend-relative.ts": `import { loadConfig } from '../../backend/src/config.js'; export const c = loadConfig;`,
  "frontend/app/r5-bare-shared.ts": `import { ApiError } from "../../shared"; export const e = ApiError;`,
  "frontend/app/r5-alias.ts": `import errors from "@/../shared/src/errors"; export const e = errors;`,
  "frontend/app/r5-dynamic.ts": `export const i = () => import("../../backend/src/index.js");`,
  "backend/src/r5-frontend.ts": `import page from '../../frontend/app/page.js'; export const p = page;`,

  // ---- rule 6 ----
  "frontend/e2e/r6-secret-in-spec.ts": `export const s = process.env.SESSION_SECRET;`,
  "frontend/app/r6-bracket.ts": `export const s = process.env["SESSION_SECRET"];`,
  "frontend/app/r6-destructure.ts": `const { DATABASE_URL } = process.env; export const d = DATABASE_URL;`,
  "frontend/app/r6-alias.ts": `const env = process.env; export const k = env.ANTHROPIC_API_KEY;`,
  "frontend/app/r6-dotted.ts": `export const k = process.env.SESSION_SECRET;`,
  "frontend/app/r6-computed.ts": `const name = "SECRET"; export const k = process.env[name];`,
  "frontend/app/r6-jsx.jsx": `export default function X() { return process.env.DATABASE_SECRET_KEY; }`,
  "frontend/app/r6-optional.ts": `export const k = process.env?.SESSION_SECRET;`,

  // ---- rule 7 ----
  "backend/packages/widget/src/r7-nested-package.ts": `import { v4 } from "uuid"; export const id = v4;`,
  "backend/src/r7-undeclared.ts": `import { sql } from "drizzle-orm"; export const q = sql;`,
  "frontend/app/r7-undeclared.ts": `import { motion } from "framer-motion"; export const m = motion;`,
};

const EXPECTED = Object.keys(FIXTURES)
  .map((f) => [f, /\/r(\d)-/.exec(f)])
  .filter(([, m]) => m)
  .map(([f, m]) => [f, Number(m[1])]);
const CLEAN = Object.keys(FIXTURES).filter((f) => /\.(tsx?|jsx?|mjs|cjs)$/.test(f) && !/\/r\d-/.test(f));

export function selfTest() {
  const dir = mkdtempSync(path.join(tmpdir(), "boundary-selftest-"));
  const failures = [];
  try {
    for (const [rel, content] of Object.entries(FIXTURES)) {
      const full = path.join(dir, rel);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    const { violations } = checkRepository(dir);
    const norm = (p) => p.split(path.sep).join("/");
    for (const [rel, rule] of EXPECTED) {
      if (!violations.some((v) => norm(v.file) === rel && v.rule === rule)) failures.push(`rule ${rule} did not catch ${rel}`);
    }
    for (const rel of CLEAN) {
      const hits = violations.filter((v) => norm(v.file) === rel);
      for (const h of hits) failures.push(`clean fixture ${rel} was reported under rule ${h.rule}: ${h.detail}`);
    }
    return { planted: EXPECTED.length, clean: CLEAN.length, failures };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const args = new Set(process.argv.slice(2));
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  let pass = 0;
  let fail = 0;
  const ok = (m) => { console.log(`  PASS  ${m}`); pass++; };
  const no = (m) => { console.log(`  FAIL  ${m}`); fail++; };

  console.log("==================================================");
  console.log("  frontend / backend boundary verification");
  console.log("==================================================");

  if (args.has("--self-test") || args.has("--all")) {
    const t = selfTest();
    if (t.failures.length === 0) ok(`the checker catches all ${t.planted} planted violations and none of ${t.clean} clean files`);
    else {
      no("the checker's self-test failed — its verdict on the real tree cannot be trusted:");
      for (const f of t.failures) console.log(`        ${f}`);
    }
    if (args.has("--self-test")) {
      console.log(`\n  boundary self-test: ${pass} passed, ${fail} failed`);
      process.exit(fail === 0 ? 0 : 1);
    }
    if (fail > 0) {
      console.log(`\n==================================================\n  boundary verification: ${pass} passed, ${fail} failed\n==================================================`);
      process.exit(1);
    }
  }

  const { violations, scanned } = checkRepository(root);
  for (const [rule, description] of RULES) {
    const hits = violations.filter((v) => v.rule === rule);
    if (hits.length === 0) ok(description);
    else {
      no(`${description}:`);
      for (const h of hits) console.log(`        ${h.file.split(path.sep).join("/")}:${h.line}  ${h.detail}`);
    }
  }
  console.log(`\n  ${scanned} source files parsed`);
  console.log("==================================================");
  console.log(`  boundary verification: ${pass} passed, ${fail} failed`);
  console.log("==================================================");
  process.exit(fail === 0 ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`  ERROR  the boundary checker itself failed: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(2);
  }
}
