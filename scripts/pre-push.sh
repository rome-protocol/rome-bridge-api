#!/usr/bin/env bash
# pre-push.sh — local gate that mirrors what CI checks before a PR can land.
#
# Run this BEFORE pushing a feature branch, so that "git push" + "gh pr create"
# only ever opens a PR that has a good chance of being green.
#
# Checks:
#   1. typecheck (tsc --noEmit) — matches CI
#   2. tests (vitest)            — matches CI
#   3. ggshield scan (if installed) — matches GitGuardian PR scan
#
# After pushing the branch, follow up with:
#   gh pr checks <BRANCH> --watch
# to wait for the remote CI + GitGuardian to confirm green BEFORE
# opening the PR.

set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> typecheck"
npm run typecheck

echo "==> tests"
npm test

echo "==> secret scan (ggshield, if installed)"
if command -v ggshield >/dev/null 2>&1; then
  # Scan the working tree + the commits we're about to push (last 50).
  # ggshield reads .gitguardian.yaml automatically.
  ggshield secret scan repo . || {
    echo "✗ ggshield surfaced potential secrets — fix or allowlist before pushing"
    exit 1
  }
else
  echo "(ggshield not installed locally — relying on the GitGuardian PR-time scan;"
  echo " ensure new high-entropy strings are public well-knowns OR added to .gitguardian.yaml)"
fi

echo
echo "✓ pre-push checks passed"
echo
echo "Next steps:"
echo "  1. git push -u origin <branch>"
echo "  2. gh pr checks <branch> --watch     # wait for remote CI to go green"
echo "  3. gh pr create ...                  # only after step 2 is clean"
