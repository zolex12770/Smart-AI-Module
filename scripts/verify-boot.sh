#!/usr/bin/env bash
# Production boot verification (docs/26_DECISIONS.md ADR-060, product brief §31).
#
# The ADR-047 audit found the deployed configuration could not boot at all: the Dockerfile
# sets NODE_ENV=production, ADR-013's guard threw whenever no LLM key was present, and the
# Cloud Run worker pool deliberately has no LLM key. Every case that was broken is checked
# here against the REAL built entrypoint (`node backend/dist/index.js`), which is exactly
# what the container runs.
#
# Usage: bash scripts/verify-boot.sh
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

PASS=0; FAIL=0; LAST_LOG=""
ok()   { echo "  PASS  $*"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL  $*"; FAIL=$((FAIL+1)); }

free_port() {
  local p=$1
  local pid
  pid=$(netstat -ano 2>/dev/null | grep ":$p " | grep LISTENING | awk '{print $5}' | head -1)
  [ -n "${pid:-}" ] && taskkill //F //PID "$pid" >/dev/null 2>&1
  return 0
}

# Boots the built entrypoint with the given env, waits for health, and reports.
# $1 = label, $2 = port, $3 = expect ("up" | "worker" | "exit"), rest = VAR=VALUE pairs
boot_case() {
  local label=$1 port=$2 expect=$3; shift 3
  local log; log=$(mktemp)
  free_port "$port"
  rm -rf "backend/data/pgdata-verify-$port"
  ( cd backend && env "$@" PORT="$port" DATABASE_DIR="./data/pgdata-verify-$port" \
      node dist/index.js >"$log" 2>&1 ) &
  local runner=$!

  local code=000
  if [ "$expect" = "worker" ]; then
    # No listener to poll: wait for the log line that proves the queue workers came up, and
    # require the process to still be alive afterwards (a crash-loop would have exited).
    for _ in $(seq 1 45); do
      grep -q "job workers registered" "$log" && break
      kill -0 "$runner" 2>/dev/null || break
      sleep 1
    done
    if grep -q "job workers registered" "$log" && kill -0 "$runner" 2>/dev/null; then
      ok "$label — booted, registered job workers, and stayed up (no HTTP listener, by design)"
    else
      bad "$label — did not reach a running worker state"
      tail -12 "$log"
    fi
    free_port "$port"
    kill "$runner" 2>/dev/null
    wait "$runner" 2>/dev/null
    rm -rf "backend/data/pgdata-verify-$port"
    LAST_LOG="$log"
    return 0
  fi

  for _ in $(seq 1 45); do
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "http://127.0.0.1:$port/api/health" || echo 000)
    [ "$code" = "200" ] && break
    kill -0 "$runner" 2>/dev/null || break
    sleep 1
  done

  if [ "$expect" = "up" ]; then
    if [ "$code" = "200" ]; then ok "$label — booted and healthy"; else
      bad "$label — never became healthy"; tail -15 "$log"; fi
  else
    if [ "$code" = "200" ]; then bad "$label — booted but should have refused"; else
      ok "$label — refused to boot, as designed"
      grep -oE "(No (real )?LLM provider|process isolation|SANDBOX)[^\"]*" "$log" | head -1 | sed 's/^/        /'
    fi
  fi

  free_port "$port"
  wait "$runner" 2>/dev/null
  rm -rf "backend/data/pgdata-verify-$port"
  LAST_LOG="$log"
}

echo "== Building the API exactly as the container does =="
npm run build:packages >/dev/null 2>&1 && npm run build -w @ai-platform/api >/dev/null 2>&1 \
  && ok "build succeeded" || { bad "build failed"; exit 1; }

echo
echo "== 1. Development boot (no keys at all) — the zero-config path =="
boot_case "dev/all, no provider" 8791 up NODE_ENV=development
grep -q "providers" "$LAST_LOG" && ok "provider registration logged at boot" || true

echo
echo "== 2. PRODUCTION worker role with NO LLM key — the exact Cloud Run worker pool config =="
echo "   (this is the case that crash-looped before ADR-060)"
boot_case "prod/worker, no key" 8792 worker NODE_ENV=production ROLE=worker

echo
echo "== 3. PRODUCTION api role with a self-hosted runtime configured (no third-party key) =="
boot_case "prod/api, local runtime" 8793 up \
  NODE_ENV=production ROLE=api LLM_BASE_URL=http://127.0.0.1:9/v1 LLM_MODEL=local-test SANDBOX_ALLOW_PROCESS_IN_PRODUCTION=true

echo
echo "== 4. PRODUCTION api role with NO provider at all — must refuse, clearly =="
boot_case "prod/api, no provider" 8794 exit NODE_ENV=production ROLE=api

echo
echo "== 5. PRODUCTION with process-level sandbox — must refuse without explicit opt-in =="
boot_case "prod/api, process sandbox" 8795 exit \
  NODE_ENV=production ROLE=api LLM_BASE_URL=http://127.0.0.1:9/v1 LLM_MODEL=local-test \
  SANDBOX_RUNTIME=process SANDBOX_ALLOW_PROCESS_IN_PRODUCTION=false

echo
echo "=================================================="
echo "  boot verification: $PASS passed, $FAIL failed"
echo "=================================================="
exit "$FAIL"
