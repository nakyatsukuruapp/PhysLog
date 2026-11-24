#!/usr/bin/env bash
# 手元の Postgres に、マイグレーションを最初から流して、権限のテストを実行する（本番には触れない）。
# 使い方（例）: PGHOST=127.0.0.1 PGPORT=54329 PGUSER=postgres ./tests/run_local.sh
set -euo pipefail
cd "$(dirname "$0")/.."
DB="${PHYSLOG_TEST_DB:-physlog_test}"
psql -X -q -v ON_ERROR_STOP=1 -d postgres -c "drop database if exists ${DB}" -c "create database ${DB}"
psql -X -q -v ON_ERROR_STOP=1 -d "${DB}" -f tests/local_stub.sql
for f in $(ls migrations/*.sql | sort); do
  echo "apply ${f}"
  psql -X -q -v ON_ERROR_STOP=1 -1 -d "${DB}" -f "${f}"
done
if [ -f tests/roles_test.sql ]; then
  # テストは最後にわざと例外を出して、作ったものをすべて巻き戻す。結果は例外の本文に入る
  out="$(PGOPTIONS="-c physlog.test_verbose=${PHYSLOG_TEST_VERBOSE:-on}" psql -X -q -d "${DB}" -f tests/roles_test.sql 2>&1 || true)"
  echo "${out}" | sed 's/^psql:[^ ]* ERROR:  //'
  echo "${out}" | grep -q "ROLLBACK_OK" || { echo "テストが最後まで走りませんでした"; exit 1; }
  if echo "${out}" | grep -q "^FAIL"; then echo "失敗あり"; exit 1; fi
  echo "すべて通りました"
fi
