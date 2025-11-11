#!/usr/bin/env bash
set -euo pipefail

APP_DB=${APP_DB:-bud}
APP_USER=${APP_USER:-bud}
APP_PASSWORD=${APP_PASSWORD:-bud_dev_password}
HOST=${HOST:-localhost}
PORT=${PORT:-5432}
SSL_MODE=${SSL_MODE:-disable}   # many local clients prefer disable

# Ensure server is running (Postgres.app)
# open -a Postgres 2>/dev/null || true

# Create role if not exists
if ! psql -d postgres -Atqc "SELECT 1 FROM pg_roles WHERE rolname='${APP_USER}'" | grep -q 1; then
  createuser -s "${APP_USER}"
fi

# Set password for the role (so TCP localhost works)
psql -d postgres -c "ALTER ROLE ${APP_USER} WITH LOGIN PASSWORD '${APP_PASSWORD}';"

# Create database if not exists and set owner
if ! psql -d postgres -Atqc "SELECT 1 FROM pg_database WHERE datname='${APP_DB}'" | grep -q 1; then
  createdb -O "${APP_USER}" "${APP_DB}"
fi

DB_URL="postgresql://${APP_USER}:${APP_PASSWORD}@${HOST}:${PORT}/${APP_DB}?sslmode=${SSL_MODE}"
echo "DATABASE_URL=${DB_URL}"
echo "To export it in this shell: export DATABASE_URL='${DB_URL}'"

# Test the URL
psql "${DB_URL}" -c '\conninfo'
