#!/usr/bin/env bash
# PROTOTYPE / SYNTHETIC DATA ONLY — reproduces every Phase 3A result from scratch.
# Requires Docker. Starts a disposable local Supabase Postgres, seeds synthetic data, runs all prototypes.
set -uo pipefail
cd "$(dirname "$0")/.."
rm -rf results .archive-store .scratch
./scripts/start-db.sh || exit 1
npx tsx src/seed.ts || exit 1
status=0
for p in env p1-freezing p2-whole-day p3-fk-graph p4-formats p5-verification p6-delete-performance p7-failure-resume p8-schema-change p9-rls-role p10-storage late-data; do
  f="src/${p}.ts"; [ "$p" = env ] && f="src/env-info.ts"
  echo "================ $p ================"
  npx tsx "$f" || status=1
done
npx tsx src/summary.ts
exit $status
