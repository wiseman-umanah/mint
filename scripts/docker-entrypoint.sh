#!/bin/sh
# Starts MINT in a container: creates what a fresh install is missing, then runs the app.
#   - secrets and testnet accounts are generated once and kept in /data/mint.env
#   - without DATABASE_URL the database is embedded (in /data) and the market maker, agent and
#     price feed run inside the app; with one, migrations run and the worker starts alongside
set -e

DATA="${MINT_DATA_DIR:-/data}"
ENV_FILE="${MINT_ENV_FILE:-$DATA/mint.env}"
export MINT_DATA_DIR="$DATA" MINT_ENV_FILE="$ENV_FILE"
mkdir -p "$DATA"
touch "$ENV_FILE"
# Only one container uses this volume, so a lock left by a hard stop is always stale.
rm -f "$DATA/pglite.lock"

load_env() {
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
}
load_env

if [ -z "$WALLET_ENCRYPTION_KEY" ] || [ -z "$SESSION_SECRET" ]; then
  echo "[mint] first run: generating secrets into $ENV_FILE"
  node -e "
    const fs = require('node:fs'), c = require('node:crypto');
    let text = fs.readFileSync(process.env.MINT_ENV_FILE, 'utf8');
    for (const name of ['WALLET_ENCRYPTION_KEY', 'SESSION_SECRET']) {
      if (!process.env[name]) text += name + '=' + c.randomBytes(32).toString('base64') + '\n';
    }
    fs.writeFileSync(process.env.MINT_ENV_FILE, text);
  "
  load_env
fi

if [ -z "$TREASURY_SECRET" ] || [ -z "$MARKET_MAKER_SECRET" ] || [ -z "$ISSUER_SECRET" ]; then
  echo "[mint] first run: creating testnet treasury, market maker and issuer (about two minutes)"
  ./node_modules/.bin/tsx scripts/bootstrap.ts || echo "[mint] testnet setup didn't finish; it will be retried on the next start"
  load_env
fi

if [ -z "$GROQ_API_KEY" ]; then
  echo "[mint] GROQ_API_KEY is not set: the chat assistant is off; everything else works"
fi

if [ -n "$DATABASE_URL" ]; then
  echo "[mint] external database: applying migrations and starting the worker"
  ./node_modules/.bin/drizzle-kit migrate
  ./node_modules/.bin/tsx scripts/worker.ts &
fi

echo "[mint] starting on http://localhost:${MINT_PORT:-3000}"
exec ./node_modules/.bin/next start -H 0.0.0.0 -p "${PORT:-3000}"
