#!/usr/bin/env bash
# ============================================================
#  UwU — setup (Linux / macOS). One command:  ./setup.sh
#  Installs deps, then patches the 26.2 protocol stack.
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

echo "🌸 UwU setup…"

# 1. Install JavaScript deps (Bun preferred, npm fallback)
if command -v bun >/dev/null 2>&1; then
  echo "→ using bun install"
  bun install
elif command -v npm >/dev/null 2>&1; then
  echo "→ using npm install"
  npm install
else
  echo "✗ Need Bun (https://bun.sh) or Node.js (https://nodejs.org)."
  echo "  Install one, then re-run ./setup.sh"
  exit 1
fi

# 2. Apply the 26.2 fork fixes (data + data.js + protocol-ID + write-shape)
if command -v python3 >/dev/null 2>&1; then
  python3 fix-26.2-protocol.py
elif command -v python >/dev/null 2>&1; then
  python fix-26.2-protocol.py
else
  echo "⚠  python3 not found — skipping protocol fix (install python3 then re-run)."
fi

echo
echo "✅ setup done. Next:"
echo "   1. cp keys.example.json keys.json   and paste your API key"
echo "   2. edit uwu.json — set \"beloved\" + (optional) \"auth_password\""
echo "   3. ./start.sh"