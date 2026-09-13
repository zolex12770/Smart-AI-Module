#!/usr/bin/env bash
#
# Frontend/backend boundary verification — docs/26_DECISIONS.md ADR-092, ADR-111.
#
# A thin wrapper, kept so CI and the documented command do not change. The checks themselves live in
# scripts/check-boundary.mjs, which reads the TypeScript syntax tree instead of grepping lines: every
# grep-based version of these checks was eventually shown to be unable to fail (that file's header
# lists how). `--all` runs the checker's self-test first — it must catch every planted violation, and
# report none of the clean fixtures, before its verdict on the real tree is believed.
#
# Exit status: 0 clean, 1 violations or a failed self-test, 2 the checker itself broke.
#
set -euo pipefail
cd "$(dirname "$0")/.."
exec node scripts/check-boundary.mjs --all
