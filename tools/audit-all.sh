#!/usr/bin/env bash
# Full static audit of UwU's command surface. Run from the repo root.
# Each check catches a failure class that node --check cannot.
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0

run() {
  echo "=== $1 ==="
  if timeout 120 ~/.bun/bin/bun "tools/$2" 2>&1 | tail -n "${3:-6}"; then :; else fail=1; fi
}

echo "=== syntax ==="
for f in $(git ls-files 'src/**/*.js'); do
  node --check "$f" || { echo "SYNTAX FAIL $f"; fail=1; }
done
echo "syntax ok"

run "relative imports"   audit-imports.mjs
run "command shape"      audit-commands.mjs
run "param signatures"   audit-params.mjs 8
run "trailing required"  audit-trailing-required.mjs
run "optional params"    audit-optional-params.mjs 4
run "dangling refs"      audit-references.mjs 3
run "module load"        audit-runtime.mjs 4
run "parse + dispatch"   audit-dispatch.mjs 6

echo
if [ "$fail" -eq 0 ]; then echo "AUDIT PASSED"; else echo "AUDIT HAD FAILURES"; fi
exit $fail
