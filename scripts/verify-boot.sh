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

# Frees a port a previous run may have left bound. This was Windows-only (netstat -ano and
# taskkill), so on Linux -- where CI runs -- it did nothing, no server was ever stopped, and the
# script hung in `wait`. The runner's own process is now killed directly (see `exec` below);
# this remains as a best-effort sweep for a leftover from an interrupted run, on either platform.
free_port() {
  local p=$1
  local pid
  if command -v taskkill >/dev/null 2>&1; then
    pid=$(netstat -ano 2>/dev/null | grep ":$p " | grep LISTENING | awk '{print $5}' | head -1)
    [ -n "${pid:-}" ] && taskkill //F //PID "$pid" >/dev/null 2>&1
  elif command -v fuser >/dev/null 2>&1; then
    fuser -k "$p/tcp" >/dev/null 2>&1
  elif command -v lsof >/dev/null 2>&1; then
    pid=$(lsof -t -iTCP:"$p" -sTCP:LISTEN 2>/dev/null | head -1)
    [ -n "${pid:-}" ] && kill "$pid" 2>/dev/null
  fi
  return 0
}

# Stops the server a case started. `$runner` IS the node process (the subshell `exec`s it), so
# this kills the server itself rather than a wrapper that would leave it running.
stop_runner() {
  kill "$1" 2>/dev/null
  for _ in $(seq 1 20); do kill -0 "$1" 2>/dev/null || break; sleep 0.5; done
  kill -9 "$1" 2>/dev/null
  wait "$1" 2>/dev/null
}

# Boots the built entrypoint with the given env, waits for health, and reports.
# $1 = label, $2 = port, $3 = expect ("up" | "worker" | "exit"), rest = VAR=VALUE pairs
boot_case() {
  local label=$1 port=$2 expect=$3; shift 3
  # A refusal case must name the reason it expects. Without this the ONLY assertion was that
  # /api/health never returned 200 -- which a port clash, a missing module, a bad migration or a
  # syntax error all satisfy just as well as the deliberate refusal being tested. The two cases
  # that exist to prove the platform refuses UNSAFE configurations were the two that could not
  # tell a correct refusal from a broken build.
  local reason=""
  if [ "$expect" = "exit" ]; then reason=$1; shift; fi
  local log; log=$(mktemp)
  free_port "$port"
  rm -rf "backend/data/pgdata-verify-$port"
  ( cd backend && exec env "$@" PORT="$port" DATABASE_DIR="./data/pgdata-verify-$port" \
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
    stop_runner "$runner"
    free_port "$port"
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
    if [ "$code" = "200" ]; then
      bad "$label — booted but should have refused"
    elif kill -0 "$runner" 2>/dev/null; then
      bad "$label — never served health, but the process is still alive: it hung rather than refusing"
      tail -15 "$log"
    elif ! grep -qE "$reason" "$log"; then
      bad "$label — refused, but NOT for the expected reason (/$reason/ absent from the log)"
      tail -15 "$log"
    else
      ok "$label — refused to boot, for the expected reason"
      grep -oE "$reason" "$log" | head -1 | sed 's/^/        /'
    fi
  fi

  stop_runner "$runner"
  free_port "$port"
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
boot_case "prod/api, no provider" 8794 exit "no LLM provider is configured, and the mock provider may not run in production" NODE_ENV=production ROLE=api

echo
echo "== 5. PRODUCTION with process-level sandbox — must refuse without explicit opt-in =="
boot_case "prod/api, process sandbox" 8795 exit "process isolation|SANDBOX_ALLOW_PROCESS_IN_PRODUCTION" \
  NODE_ENV=production ROLE=api LLM_BASE_URL=http://127.0.0.1:9/v1 LLM_MODEL=local-test \
  SANDBOX_RUNTIME=process SANDBOX_ALLOW_PROCESS_IN_PRODUCTION=false

echo
echo "== 6. PRODUCTION api role with a bucket and an UNWRITABLE local asset path =="
echo "   (ADR-151: boot used to mkdir ASSETS_ROOT unconditionally, on a filesystem the"
echo "    Terraform itself calls read-only, for a directory the cloud store never opens)"
# "package.json/assets" cannot be created: the parent is a regular file, so mkdirSync throws
# ENOTDIR — the same shape as EROFS on a read-only container root, and reproducible anywhere.
boot_case "prod/api, bucket + unwritable ASSETS_ROOT" 8796 up   NODE_ENV=production ROLE=api LLM_BASE_URL=http://127.0.0.1:9/v1 LLM_MODEL=local-test   SANDBOX_ALLOW_PROCESS_IN_PRODUCTION=true   ASSETS_BUCKET=verify-boot-bucket ASSETS_ROOT=./package.json/assets

echo
echo "=================================================="
echo "  boot verification: $PASS passed, $FAIL failed"
echo "=================================================="
exit "$FAIL"
