#!/usr/bin/env bash
# PROTOTYPE / SYNTHETIC DATA ONLY
# Starts a disposable local Supabase Postgres (official image) with Nano-like limits.
# Nothing here connects to any hosted Supabase project.
set -euo pipefail
NAME="${PROTO_DB_NAME:-uniqbotz-proto}"
IMAGE="${PROTO_DB_IMAGE:-supabase/postgres:17.6.1.066}"
PORT="${PROTO_DB_PORT:-54329}"
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" \
  --cpus="${PROTO_DB_CPUS:-0.5}" --memory="${PROTO_DB_MEMORY:-512m}" \
  -e POSTGRES_PASSWORD=prototype-local-only \
  -p "127.0.0.1:${PORT}:5432" \
  "$IMAGE" >/dev/null
echo "waiting for $NAME ..."
for i in $(seq 1 90); do
  if docker exec "$NAME" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1; then
    sleep 3; echo "ready on 127.0.0.1:${PORT}"; exit 0
  fi
  sleep 1
done
echo "database did not become ready" >&2; docker logs "$NAME" | tail -20; exit 1
