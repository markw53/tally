#!/usr/bin/env bash
# Runs schema.sql against a throwaway Postgres and asserts the two things the
# design rests on: newest-wins merging, and RLS keeping two diaries apart.
#
#   ./supabase/test/run.sh                     # starts its own cluster
#   PGURL=postgres://... ./supabase/test/run.sh  # or use one you already have
#
# Needs postgresql-16 (or later) locally. Nothing here touches your project.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
schema="$here/../schema.sql"

if [ -n "${PGURL:-}" ]; then
  psql_cmd=(psql "$PGURL")
else
  export PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
  data="${TMPDIR:-/tmp}/tally-pgtest"
  sock="$data"
  trap '"$PGBIN/pg_ctl" -D "$data" stop -m immediate >/dev/null 2>&1 || true' EXIT

  rm -rf "$data"; mkdir -p "$data"
  "$PGBIN/initdb" -D "$data" -A trust -U postgres >/dev/null
  "$PGBIN/pg_ctl" -D "$data" -o "-k $sock -p 5433 -c listen_addresses=" -l "$data/log" start >/dev/null
  psql_cmd=(psql -h "$sock" -p 5433 -U postgres -d postgres)
fi

"${psql_cmd[@]}" -q -v ON_ERROR_STOP=1 -f "$here/shim.sql" >/dev/null
"${psql_cmd[@]}" -q -v ON_ERROR_STOP=1 -f "$schema" >/dev/null
"${psql_cmd[@]}" -q -v ON_ERROR_STOP=1 -f "$here/run.sql"
