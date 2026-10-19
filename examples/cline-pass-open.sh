#!/bin/sh
# Open the current opencode Cline Pass dashboard in the default browser.
# The dashboard port is ephemeral, so resolve it from the runtime pointer.
set -eu
STATE="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/cline-pass.runtime.json"
if [ ! -f "$STATE" ]; then
  echo "Cline Pass is not running: $STATE not found" >&2
  exit 1
fi
if command -v jq >/dev/null 2>&1; then
  URL=$(jq -r '.dashboard // empty' "$STATE")
elif command -v node >/dev/null 2>&1; then
  URL=$(STATE="$STATE" node -p "try{require(process.env.STATE).dashboard||''}catch(e){''}")
else
  echo "jq or node is required to read $STATE" >&2
  exit 1
fi
if [ -z "$URL" ]; then
  echo "Cline Pass dashboard URL missing from $STATE" >&2
  exit 1
fi
case "$(uname -s)" in
  Darwin) open "$URL" ;;
  Linux) xdg-open "$URL" >/dev/null 2>&1 ;;
  *) echo "Open this URL: $URL" ;;
esac
echo "Cline Pass dashboard: $URL"
