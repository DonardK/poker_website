#!/bin/sh
# Local docker only. Runs once, when the data volume is first created, as the
# database superuser, BEFORE migrations. The migration then grants poker_server
# to this role. The password comes from POKER_APP_PASSWORD and is never written
# into a migration or echoed here.
set -eu
if [ -z "${POKER_APP_PASSWORD:-}" ]; then
  echo "poker_app: POKER_APP_PASSWORD is unset. After migrations, set it with ALTER ROLE poker_app PASSWORD '...'; (apps/server/prisma/RUNTIME_ROLE.md)." >&2
  exit 0
fi
case "$POKER_APP_PASSWORD" in
  *[!A-Za-z0-9]*)
    echo "POKER_APP_PASSWORD must contain only letters and digits, at least 16." >&2
    exit 1
    ;;
esac
if [ "${#POKER_APP_PASSWORD}" -lt 16 ]; then
  echo "POKER_APP_PASSWORD must be at least 16 characters." >&2
  exit 1
fi
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_password="$POKER_APP_PASSWORD" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'poker_app') THEN
    CREATE ROLE poker_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS NOREPLICATION;
  END IF;
END
$$;
ALTER ROLE poker_app PASSWORD :'app_password';
SQL
