#!/usr/bin/env bash
# Timestamped tarball of Backend source + scripts (excludes node_modules).
# Usage: ./scripts/backup-src-snapshot.sh
# Restore: tar -xzf Backend_snapshots/Backend_src_<ts>.tar.gz -C /path/to/parent

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEFAULT_DEST="$ROOT/Backend_snapshots"
DEST="${BACKUP_SNAPSHOT_DIR:-$DEFAULT_DEST}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
if ! mkdir -p "$DEST" 2>/dev/null; then
  DEST="${TMPDIR:-/tmp}/StatarbDeribit_backend_snapshots"
  mkdir -p "$DEST"
  echo "[backup-src-snapshot] using $DEST (set BACKUP_SNAPSHOT_DIR to override)" >&2
fi
OUT="$DEST/Backend_src_${TS}.tar.gz"

EXTRA=()
[[ -f "$ROOT/package-lock.json" ]] && EXTRA+=(package-lock.json)

tar -czf "$OUT" \
  -C "$ROOT" \
  --exclude='node_modules' \
  --exclude='Backend_snapshots' \
  src scripts package.json "${EXTRA[@]}"

echo "$OUT"
ls -lh "$OUT"
