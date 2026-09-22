#!/usr/bin/env bash
# Backup Griffin knowledge (+ the SQLite database) off the live data dir.
#   GRIFFIN_WORKSPACE=/srv/griffin/workspace GRIFFIN_DATA=/srv/griffin/data \
#   OUT=/srv/griffin/backups ./deploy/scripts/backup-knowledge.sh
# Copy OUT/*.tgz somewhere that is not this host.
set -euo pipefail

WORKSPACE="${GRIFFIN_WORKSPACE:-/srv/griffin/workspace}"
DATA="${GRIFFIN_DATA:-/srv/griffin/data}"
OUT="${OUT:-/srv/griffin/backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT"

KNOW="$WORKSPACE/knowledge"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [[ -d "$KNOW" ]]; then
  tar -C "$WORKSPACE" -czf "$TMP/knowledge-$STAMP.tgz" knowledge
else
  echo "no knowledge dir at $KNOW — packing empty marker" >&2
  mkdir -p "$TMP/empty/knowledge"
  echo "no knowledge yet" >"$TMP/empty/knowledge/EMPTY"
  tar -C "$TMP/empty" -czf "$TMP/knowledge-$STAMP.tgz" knowledge
fi

DB="griffin.sqlite"
if [[ -f "$DATA/$DB" ]]; then
  if command -v sqlite3 >/dev/null 2>&1; then
    # .backup is consistent while the app is running; a plain copy is not.
    sqlite3 "$DATA/$DB" ".backup '$TMP/$DB'"
    tar -C "$TMP" -czf "$OUT/griffin-data-$STAMP.tgz" "$DB"
  else
    mkdir -p "$TMP/data"
    cp -a "$DATA/$DB" "$TMP/data/"
    [[ -f "$DATA/$DB-wal" ]] && cp -a "$DATA/$DB-wal" "$TMP/data/" || true
    [[ -f "$DATA/$DB-shm" ]] && cp -a "$DATA/$DB-shm" "$TMP/data/" || true
    tar -C "$TMP" -czf "$OUT/griffin-data-$STAMP.tgz" data
  fi
fi

cp -a "$TMP/knowledge-$STAMP.tgz" "$OUT/"
ls -1t "$OUT"/knowledge-*.tgz 2>/dev/null | tail -n +15 | xargs -r rm -f
ls -1t "$OUT"/griffin-data-*.tgz 2>/dev/null | tail -n +15 | xargs -r rm -f

echo "wrote:"
ls -lh "$OUT"/knowledge-"$STAMP".tgz 2>/dev/null || true
ls -lh "$OUT"/griffin-data-"$STAMP".tgz 2>/dev/null || true
echo "OFF-BOX: copy $OUT off this host."
