#!/bin/sh
set -eu

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required."
  exit 1
fi

RAW_DB_URL="${DATABASE_URL#postgresql://}"
RAW_DB_URL="${RAW_DB_URL#postgres://}"
RAW_DB_URL="${RAW_DB_URL%%\?*}"

DB_CREDENTIALS="${RAW_DB_URL%%@*}"
DB_HOST_AND_NAME="${RAW_DB_URL#*@}"
DB_HOST_PORT="${DB_HOST_AND_NAME%%/*}"
DB_NAME="${DB_HOST_AND_NAME#*/}"

NAKAMA_DB_ADDRESS="${DB_CREDENTIALS}@${DB_HOST_PORT}/${DB_NAME}"

: "${PORT:=10000}"
: "${NAKAMA_SERVER_KEY:=defaultkey}"
: "${NAKAMA_RUNTIME_HTTP_KEY:=replace-me-http-key}"
: "${NAKAMA_SESSION_ENCRYPTION_KEY:=replace-me-session-key}"
: "${NAKAMA_REFRESH_ENCRYPTION_KEY:=replace-me-refresh-key}"
: "${NAKAMA_CONSOLE_USERNAME:=admin}"
: "${NAKAMA_CONSOLE_PASSWORD:=password}"
: "${NAKAMA_CONSOLE_SIGNING_KEY:=replace-me-console-signing-key}"

/nakama/nakama migrate up --database.address "${NAKAMA_DB_ADDRESS}?sslmode=require"

exec /nakama/nakama \
  --name nakama1 \
  --database.address "${NAKAMA_DB_ADDRESS}?sslmode=require" \
  --runtime.path=/nakama/data/modules \
  --runtime.js_entrypoint=match.js \
  --logger.level INFO \
  --socket.port "${PORT}" \
  --console.port 10001 \
  --socket.server_key "${NAKAMA_SERVER_KEY}" \
  --runtime.http_key "${NAKAMA_RUNTIME_HTTP_KEY}" \
  --session.encryption_key "${NAKAMA_SESSION_ENCRYPTION_KEY}" \
  --session.refresh_encryption_key "${NAKAMA_REFRESH_ENCRYPTION_KEY}" \
  --session.token_expiry_sec 7200 \
  --session.refresh_token_expiry_sec 604800 \
  --console.username "${NAKAMA_CONSOLE_USERNAME}" \
  --console.password "${NAKAMA_CONSOLE_PASSWORD}" \
  --console.signing_key "${NAKAMA_CONSOLE_SIGNING_KEY}"
