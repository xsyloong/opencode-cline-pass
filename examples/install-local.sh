#!/usr/bin/env bash
set -euo pipefail
# Backwards-compatible entry point; the full installer lives in install.sh.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec "$ROOT/install.sh" "$@"
