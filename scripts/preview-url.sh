#!/bin/sh
# Prints the Worker Preview's URL from the output of `wrangler preview --json`,
# saved in a file. Wrangler prints asset-upload progress before the JSON, so
# this reads from the first line that opens it. Exits 1, showing the output
# with every email address hidden, when there's no URL in it. Never print that
# output any other way: it includes the email of the Cloudflare account that
# owns the deploy token, and this repo's Actions logs are public.
# Usage: sh scripts/preview-url.sh <file>
set -u
file="${1:?usage: sh scripts/preview-url.sh <wrangler-output-file>}"
json=$(sed -n '/^{/,$p' "$file")
if printf '%s\n' "$json" | jq -er '.preview.urls[0] // empty' 2>/dev/null; then
  exit 0
fi
# To stderr: the workflow captures stdout as the URL, and the error must still
# show in the log.
echo "::error::wrangler preview didn't report a preview URL" >&2
if printf '%s\n' "$json" | jq -e '.preview' >/dev/null 2>&1; then
  echo "::error::The Preview deployed without a URL, so Preview URLs are off for the Worker. preview_urls = true in wrangler.toml turns them on at the next production deploy." >&2
fi
sh "$(dirname "$0")/hide-emails.sh" <"$file" >&2
exit 1
