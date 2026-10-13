#!/usr/bin/env bash
# Apply vendored patches with GNU patch (not patch-package).
#
# patch-package 8.0.1 cannot parse patches/mineflayer+4.37.1.patch
# ("patch file could not be parsed") while GNU patch applies it cleanly —
# proven by tests/patch_applies.test.mjs. So postinstall uses this instead.
# -N (--forward + skip already-applied) makes re-runs free and silent.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
applied=0; skipped=0; failed=0
for pf in "$ROOT"/patches/*.patch; do
  [ -e "$pf" ] || continue
  name="$(basename "$pf")"
  out="$(patch -p1 -N --batch -d "$ROOT" < "$pf" 2>&1)"
  rc=$?
  if echo "$out" | grep -q "Skipping\|previously applied\|Reversed (or previously"; then
    skipped=$((skipped+1))
  elif [ $rc -eq 0 ]; then
    echo "apply-patches: $name applied"
    applied=$((applied+1))
  else
    echo "apply-patches: $name FAILED :: $out" | head -5
    failed=$((failed+1))
  fi
done
echo "apply-patches: $applied applied, $skipped skipped, $failed failed"
[ "$failed" -eq 0 ]
