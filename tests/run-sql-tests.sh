#!/usr/bin/env bash
# Executes tests/sql/*.test.sql against a throwaway local Postgres.
# Skips (exit 0) with a loud notice when no server binaries are available, so
# `npm test` stays runnable on machines without Postgres — but never pretends
# the SQL tests passed.
set -uo pipefail
PGBIN=$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | tail -1)
if [ -z "${PGBIN:-}" ] || [ ! -x "$PGBIN/initdb" ]; then
  echo "SKIP: no local PostgreSQL server; tests/sql/*.test.sql NOT executed" >&2
  exit 0
fi
RUNAS=$(id -u postgres >/dev/null 2>&1 && echo postgres || echo "")
[ -z "$RUNAS" ] && { echo "SKIP: no unprivileged postgres user available" >&2; exit 0; }

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d /tmp/pgsqltest.XXXXXX)
mkdir -p "$TMP/data" "$TMP/sock" && chown -R "$RUNAS" "$TMP"
cleanup() { su "$RUNAS" -s /bin/bash -c "$PGBIN/pg_ctl -D $TMP/data -m immediate stop" >/dev/null 2>&1; rm -rf "$TMP"; }
trap cleanup EXIT

su "$RUNAS" -s /bin/bash -c "
  $PGBIN/initdb -D $TMP/data -A trust -U postgres > $TMP/initdb.log 2>&1 &&
  $PGBIN/pg_ctl -D $TMP/data -o '-k $TMP/sock -c listen_addresses=' -l $TMP/pg.log -w start > /dev/null 2>&1
" || { echo "FAIL: could not start PostgreSQL"; tail -5 "$TMP"/*.log; exit 1; }

# كل ملف يُنفَّذ **مرة واحدة** ويُحتفظ بمخرجاته.
#
# كان يُنفَّذ مرتين — واحدة للعرض وأخرى لالتقاط رمز الخروج — بلا إسقاط المخطط
# بينهما. فالتنفيذ الثاني كان يصطدم دائمًا بـ«relation already exists» ويضبط
# rc=1، أي أن هذه الحزمة كانت **تخرج بفشل دائمًا** مهما نجحت التأكيدات،
# فرمز خروج `npm test` لم يكن يعني شيئًا.
rc=0
for f in "$ROOT"/tests/sql/*.test.sql; do
  echo "── $(basename "$f")"
  out=$( cd "$ROOT" && psql -h "$TMP/sock" -U postgres -q -f "$f" postgres 2>&1 )
  status=$?
  echo "$out" | grep -E "PASS|FAIL|ERROR|ALL " || true
  if [ $status -ne 0 ]; then
    rc=1
    echo "   ↑ psql exited $status"
  fi
  psql -h "$TMP/sock" -U postgres -q -c "drop schema if exists public cascade; create schema public; drop schema if exists auth cascade; drop schema if exists storage cascade;" postgres >/dev/null 2>&1
done
exit $rc
