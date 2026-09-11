#!/usr/bin/env bash
#
# Migration validation — docs/26_DECISIONS.md ADR-087.
#
# Completion criterion: "migration clean from an empty database". Nothing verified it. The suite
# calls `runMigrations` constantly, but always against a fresh in-memory PGlite inside a test that
# would fail for a hundred other reasons too, so a broken migration was never distinguishable from
# a broken test. And the risk is specific and real: the schema is edited by hand while migrations
# are generated, so a column added without a regenerated migration passes every test (the test
# database is built from the migrations AND the ORM agrees with the schema file) and then fails on
# the first real deployment, where only the migrations exist.
#
# Three things are checked, in the order they can fail:
#   1. Migrations apply to a genuinely empty database.
#   2. Applying them twice is a no-op — a deploy that retries must not fail.
#   3. `drizzle-kit generate` produces NOTHING new, i.e. the checked-in migrations really do
#      describe the current schema. This is the check that catches the hand-edit drift.
#
set -euo pipefail
cd "$(dirname "$0")/.."

pass=0
fail=0
say() { printf '  %s\n' "$*"; }
ok() { say "PASS  $*"; pass=$((pass + 1)); }
no() { say "FAIL  $*"; fail=$((fail + 1)); }

WORK="$(mktemp -d 2>/dev/null || echo "./.migration-check")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

echo "=================================================="
echo "  migration verification"
echo "=================================================="

npm run build --workspace=@ai-platform/database >/dev/null 2>&1

# --- 1 + 2: apply to an empty database, then apply again -------------------------------
# Written INSIDE the repository, not into $WORK: node resolves `@ai-platform/database` through
# the workspace node_modules, and a script in a temp directory is outside that tree entirely.
APPLY="./.verify-migrations-apply.mjs"
cleanup_apply() { rm -f "$APPLY"; }
trap 'cleanup; cleanup_apply' EXIT
cat > "$APPLY" <<'NODE'
import { createDb, runMigrations } from "@ai-platform/database";

const dir = process.argv[2];
const db = await createDb(dir);
await runMigrations(db);

// Every table the application expects must exist after the migrations alone — no ORM, no
// test helper, just SQL against what the migration files produced.
const { rows } = await db.$client.query(
  "select table_name from information_schema.tables where table_schema = 'public' order by table_name"
);
const tables = rows.map((r) => r.table_name);

// Applying a second time must be a no-op rather than an error: a deploy that retries, or two
// instances starting at once, both run this.
await runMigrations(db);

await db.$client.close();
console.log(JSON.stringify(tables));
NODE

say "applying migrations to an empty database..."
if OUT=$(node "$APPLY" "$WORK/pgdata" 2>"$WORK/err.txt"); then
  ok "migrations applied to an empty database, and applied again without error"
else
  no "migrations did not apply cleanly"
  sed 's/^/        /' "$WORK/err.txt" | head -20
fi

# --- the tables the application actually requires ---------------------------------------
if [ -n "${OUT:-}" ]; then
  MISSING=""
  for t in users organizations organization_members projects project_members sessions api_keys \
           audit_log conversations messages tasks task_nodes task_transitions documents \
           document_chunks memory_items assets image_generations video_projects video_scenes \
           usage_records rate_limit_counters; do
    echo "$OUT" | grep -q "\"$t\"" || MISSING="$MISSING $t"
  done
  if [ -z "$MISSING" ]; then
    ok "all 22 application tables exist after migration"
  else
    no "tables missing after migration:$MISSING"
  fi
fi

# --- 3: the checked-in migrations describe the current schema ---------------------------
# The one that catches a hand-edited schema with no regenerated migration — which passes every
# test and then fails on the first real deployment.
say "checking the schema against the checked-in migrations..."
BEFORE=$(ls packages/database/migrations/*.sql | wc -l)
GEN=$(npm run db:generate --workspace=@ai-platform/database 2>&1 || true)
AFTER=$(ls packages/database/migrations/*.sql | wc -l)

if [ "$BEFORE" -eq "$AFTER" ]; then
  ok "no schema drift — the migrations describe the current schema"
else
  no "schema drift: drizzle-kit generated a new migration, so the schema was edited without one"
  echo "$GEN" | tail -5 | sed 's/^/        /'
  say "      run: npm run db:generate -w @ai-platform/database, and commit the result"
fi

echo
echo "=================================================="
echo "  migration verification: $pass passed, $fail failed"
echo "=================================================="
[ "$fail" -eq 0 ]
