#!/usr/bin/env bash
# ============================================================
#  UwU — start the bot.  ./start.sh   (after ./setup.sh once)
# ============================================================
cd "$(dirname "$0")"

if command -v bun >/dev/null 2>&1; then
  exec bun main.js
elif command -v node >/dev/null 2>&1; then
  exec node main.js
else
  echo "✗ Need Bun or Node.js. Run ./setup.sh first."
  exit 1
fi