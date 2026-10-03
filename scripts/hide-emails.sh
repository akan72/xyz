#!/bin/sh
# Copies stdin to stdout with every email address replaced by "<email hidden>".
# Wrangler names the email of the Cloudflare account that owns the deploy
# token, in its deployment records and after an authentication error, and this
# repo's Actions logs are public, so everything it prints in CI goes through
# this first.
# Usage: <command> 2>&1 | sh scripts/hide-emails.sh
exec sed -E 's/[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,}/<email hidden>/g'
