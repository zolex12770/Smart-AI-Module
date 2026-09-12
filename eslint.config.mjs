import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * The single lint configuration for the whole monorepo.
 *
 * WHY ONE ROOT CONFIG, NOT ONE PER WORKSPACE. The root `lint` script used to be
 * `npm run lint --workspaces --if-present`, and not one of the 26 workspaces defined a `lint`
 * script. `--if-present` swallowed all 26 misses and the command exited 0 without reading a
 * single file: a gate that could not fail. Per-package configs reintroduce exactly that hole —
 * a new package that forgets to opt in is silently skipped, and nothing reports the omission.
 * One root config walking `apps/**` and `packages/**` cannot skip a package, because no package
 * has to do anything to be covered.
 *
 * WHY .mjs AND NOT .js. The root package.json has no `"type": "module"` — every workspace
 * declares one, the root does not. An ESM `eslint.config.js` there still loads (Node sniffs the
 * syntax) but prints a MODULE_TYPELESS_PACKAGE_JSON warning on every single run, which is noise
 * on a gate that is supposed to be read.
 *
 * WHY THESE RULES. Style is deliberately absent. A gate that reports a thousand formatting
 * complaints is a gate everyone learns to skip, and skipping it is indistinguishable from
 * passing it. Everything enabled below either cannot be anything but a defect, or is one often
 * enough to be worth a human look. Rules considered and rejected are named at the bottom.
 */
export default tseslint.config(
  {
    // Nothing here is hand-written, so a finding in it is never actionable: build output,
    // drizzle-kit's generated migrations (`out` in packages/database/drizzle.config.ts), the
    // Next.js build cache, emitted declarations, and the locally-installed verification
    // toolchain from ADR-078.
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "frontend/.next/**",
      "**/migrations/**",
      "**/*.d.ts",
      ".local-tools/**",
      ".claude/**",
      "coverage/**",
      "**/playwright-report/**",
      "**/test-results/**",
    ],
  },

  {
    // Every TypeScript file in the repo. `files` is explicit rather than inherited so that
    // apps/web/next.config.mjs — the one JavaScript file in the tree — is left alone.
    files: ["frontend/**/*.{ts,tsx,mts,cts}", "backend/**/*.{ts,tsx,mts,cts}", "shared/**/*.{ts,tsx,mts,cts}"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    rules: {
      // The TypeScript-aware version understands type-only imports and enum members, which the
      // core rule reports as unused. A leading underscore is the established opt-out for a
      // binding that exists to satisfy a signature (an ignored callback argument, a
      // deliberately-swallowed catch binding) rather than to be read.
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],

      // A warning, not an error. Several files console.log on purpose — the migration CLI, the
      // config loader's boot-time warnings, pg-boss's error hook — and those already carry
      // eslint-disable comments. Erroring here would push everyone toward more disables, which
      // teaches the habit of silencing this file rather than reading it.
      "no-console": "warn",
    },
  },

  {
    // Type-aware overlay. Only three rules, all of them about the same failure mode: async work
    // whose result is dropped on the floor. This codebase is almost entirely asynchronous — job
    // workers, provider streams, repository calls — and a promise nobody waits on does not throw
    // anywhere a human will see it; the job simply reports success and the write never happened.
    // That is worth the type information these rules need.
    //
    // COST: about 12 seconds on top of a 19-second syntax-only run, for ~150 files. Acceptable.
    // The broader `recommendedTypeChecked` set was measured and rejected (see the bottom).
    files: ["frontend/**/*.{ts,tsx}", "backend/**/*.{ts,tsx}", "shared/**/*.{ts,tsx}"],
    ignores: [
      // Every workspace tsconfig excludes its own tests (`"exclude": ["src/**/*.test.ts"]`), and
      // the vitest/drizzle config files sit outside `include` entirely, so the TypeScript project
      // service has no program for them and type-aware parsing fails outright. Listing them by
      // shape rather than by path means a new package's tests and configs are handled without
      // anyone remembering to come back here.
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/*.config.ts",
      // Test-fixture builders are excluded from their package's tsconfig for the same reason
      // tests are, so they need the same treatment. By shape, not by path: a third one
      // (video-replicate's mp4-fixtures.ts) appeared within a day of the first two being listed
      // individually, and the next package to add one should not have to find this file.
      "**/*-fixtures.ts",
      "backend/src/test-app.ts",
    ],
    languageOptions: {
      // `projectService` instead of an explicit `project` list: it follows each file to its
      // nearest tsconfig, which is what makes this work across 26 workspaces wired with project
      // references without maintaining a parallel list of tsconfig paths here.
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        {
          // `onSubmit={async (e) => ...}` is how React is written, and React genuinely ignores
          // the returned promise — the handler owns its own try/catch, as every form in apps/web
          // does. All 14 hits of this rule were that pattern and none was a bug. The other half
          // of the rule, which catches `if (somePromise)` and an async callback passed where a
          // synchronous predicate is expected, stays on: those are always wrong.
          checksVoidReturn: { attributes: false },
        },
      ],
    },
  },

  {
    // `as any` in a test is a deliberate, local escape: narrowing a discriminated union to
    // assert on one variant's payload, or reaching into a vi.fn()'s `.mock.calls`. A test that
    // lies about a type can only mislead itself, and the honest alternative — 25 inline disables
    // across three provider suites — would be strictly less readable. Production code still
    // errors on `any`, and currently has none.
    files: ["**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  }

  // MEASURED AND REJECTED, so nobody has to measure them again:
  //
  //   stylisticTypeChecked (array-type, prefer-optional-chain, prefer-nullish-coalescing, ...)
  //     ~40 hits, every one a formatting preference. This is the noise the gate exists to avoid.
  //
  //   no-base-to-string — 24 hits, all of the form `String(args.path ?? "")` where `args` is the
  //     `Record<string, unknown>` an LLM handed a tool. The String() call IS the coercion of
  //     untrusted input; the rule is describing the design, not finding a bug in it.
  //
  //   require-await — 7 hits, all interface conformance: a ToolHandler must return a promise
  //     whether or not its body awaits anything. Removing `async` would break the contract.
  //
  //   no-unsafe-assignment / no-unsafe-argument — 12 hits, all `JSON.parse` results and vendor
  //     SDK `any`s. Silencing them properly means real schema work, not a lint fix.
  //
  //   no-shadow — 7 hits, every one a `catch (e)` inside a handler whose event parameter is also
  //     `e`, plus one intentional shadow where Playwright's `page.evaluate` receives a value by
  //     the same name it has outside. No confusion, no defect.
  //
  //   require-atomic-updates — 4 hits, all the documented false positive: assigning a property
  //     of `request` after an await inside a Fastify hook.
);
