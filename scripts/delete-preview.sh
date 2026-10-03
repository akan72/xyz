#!/bin/sh
# Tears down a PR's Worker Preview, pr-<N> of the xyz Worker, for
# .github/workflows/pr-preview-cleanup.yml. Exits 0 when it was deleted or
# never existed, and 1 on any other failure, so a preview that's still live
# never reads as "never deployed". Writes deleted=true|false to
# $GITHUB_OUTPUT when that variable is set.
# Usage, from the repo root (wrangler reads the Worker's name from wrangler.toml):
#   WRANGLER="npx --yes wrangler@<version>" sh scripts/delete-preview.sh <pr-number>
set -u
pr="${1:-}"
# Only a PR number, so this only ever deletes a pr-<N> Preview.
case "$pr" in
  '' | *[!0-9]*)
    echo "usage: sh scripts/delete-preview.sh <pr-number>" >&2
    exit 1
    ;;
esac
wrangler="${WRANGLER:-npx --yes wrangler}"

# $wrangler is split into words on purpose.
out=$($wrangler preview delete --name "pr-$pr" --skip-confirmation 2>&1)
code=$?
printf '%s\n' "$out"
if [ "$code" -eq 0 ]; then
  deleted=true
elif printf '%s' "$out" | grep -qi -e 'not found' -e 'does not exist'; then
  deleted=false
else
  echo "::error::Deleting the Worker Preview pr-$pr failed (wrangler exited $code), so it may still be live."
  exit 1
fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "deleted=$deleted" >>"$GITHUB_OUTPUT"
fi
echo "deleted=$deleted"
