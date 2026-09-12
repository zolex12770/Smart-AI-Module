#!/usr/bin/env bash
#
# Frontend/backend boundary verification — docs/26_DECISIONS.md ADR-092.
#
# The brief calls the separation NON-NEGOTIABLE, and a directory layout does not enforce it: one
# `import` is all it takes to couple the two applications again, and it would typecheck, build and
# pass every test. This script is what makes the boundary a thing that can FAIL.
#
# It checks the properties that actually matter, not merely that two folders exist:
#   1. The frontend imports no backend package.
#   2. The frontend imports `shared` for TYPES ONLY — a runtime import would put backend code in
#      the browser bundle, and `shared` carries zod schemas and error classes.
#   3. The frontend never reaches the database, a queue, or the filesystem.
#   4. The backend imports nothing from the frontend.
#   5. Neither reaches across the directory boundary by relative path.
#   6. No server secret is readable from frontend code.
#
set -euo pipefail
cd "$(dirname "$0")/.."

pass=0
fail=0
ok() { printf '  PASS  %s\n' "$*"; pass=$((pass + 1)); }
no() { printf '  FAIL  %s\n' "$*"; fail=$((fail + 1)); }

# Source files of one application, excluding build output and dependencies.
sources() {
  find "$1" -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.mts' \) \
    -not -path '*/node_modules/*' -not -path '*/dist/*' -not -path '*/.next/*' 2>/dev/null
}

echo "=================================================="
echo "  frontend / backend boundary verification"
echo "=================================================="

# --- 1. the frontend must not import a backend package ---------------------------------
BACKEND_PKGS='@ai-platform/(agent-core|database|embeddings|jobs|mcp|media|memory|model-router|observability|quota|rag|scanning|security|tools|api|llm-[a-z]+|image-[a-z]+|video-[a-z]+)'
HITS=$(sources frontend | xargs grep -lE "from \"$BACKEND_PKGS\"|require\(\"$BACKEND_PKGS\"" 2>/dev/null || true)
if [ -z "$HITS" ]; then
  ok "frontend imports no backend package"
else
  no "frontend imports backend packages:"
  echo "$HITS" | sed 's/^/        /'
fi

# --- 2. the frontend's `shared` imports must be TYPE-ONLY -------------------------------
# `import type` is erased at compile time. A value import would pull zod and the error classes
# into the browser bundle and make the contract a runtime dependency instead of a contract.
# Match any line importing shared, then subtract the type-only ones. A `^` inside an
# alternation group does not anchor reliably in ERE, which is how the first version of this
# check silently matched nothing and reported a pass -- a boundary check that cannot fail is
# worse than no check at all.
RUNTIME=$(sources frontend | xargs grep -n "@ai-platform/shared" 2>/dev/null \
  | grep -E "import|require" \
  | grep -v "import type" \
  | grep -v '"@ai-platform/shared":' || true)
if [ -z "$RUNTIME" ]; then
  ok "every frontend import of shared/ is type-only"
else
  no "frontend has RUNTIME imports of shared/:"
  echo "$RUNTIME" | sed 's/^/        /'
fi

# --- 3. the frontend must not touch infrastructure directly ----------------------------
INFRA=$(sources frontend | xargs grep -nE "from \"(drizzle-orm|pg|pg-boss|@electric-sql/pglite|node:fs|node:child_process)\"" 2>/dev/null || true)
if [ -z "$INFRA" ]; then
  ok "frontend reaches no database, queue, filesystem or subprocess"
else
  no "frontend reaches infrastructure directly:"
  echo "$INFRA" | sed 's/^/        /'
fi

# --- 4. the backend must not import the frontend ---------------------------------------
WEB=$(sources backend | xargs grep -lE "@ai-platform/web|from \"next/|from \"react\"" 2>/dev/null || true)
if [ -z "$WEB" ]; then
  ok "backend imports nothing from the frontend"
else
  no "backend imports frontend code:"
  echo "$WEB" | sed 's/^/        /'
fi

# --- 5. no relative path crosses the boundary ------------------------------------------
# The failure this catches is a `../../backend/src/...` import, which would bypass the package
# boundary entirely and couple the two applications at the filesystem level.
CROSS=$(sources frontend | xargs grep -nE "from \"[./]+(backend|shared)/" 2>/dev/null || true)
CROSS="$CROSS$(sources backend | xargs grep -nE "from \"[./]+(frontend)/" 2>/dev/null || true)"
if [ -z "$(echo "$CROSS" | tr -d '[:space:]')" ]; then
  ok "no relative import crosses the application boundary"
else
  no "relative imports cross the boundary:"
  echo "$CROSS" | sed 's/^/        /'
fi

# --- 6. no server secret is reachable from the frontend --------------------------------
# Next.js only exposes NEXT_PUBLIC_* to the browser, so any OTHER env var read in frontend code
# is either dead or a secret someone expects to be there — both worth failing on.
SECRETS=$(sources frontend | xargs grep -nE "process\.env\.(?!NEXT_PUBLIC_)[A-Z_]+" -P 2>/dev/null \
  | grep -vE "NODE_ENV|E2E_|CI\b" || true)
if [ -z "$SECRETS" ]; then
  ok "frontend reads no server-side environment variable"
else
  no "frontend reads non-public environment variables:"
  echo "$SECRETS" | sed 's/^/        /'
fi

# --- 7. each application declares its own dependencies ---------------------------------
for app in frontend backend shared; do
  if [ -f "$app/package.json" ]; then
    ok "$app/ is its own package with its own dependencies"
  else
    no "$app/package.json is missing — it is not an independent application"
  fi
done

echo
echo "=================================================="
echo "  boundary verification: $pass passed, $fail failed"
echo "=================================================="
[ "$fail" -eq 0 ]
