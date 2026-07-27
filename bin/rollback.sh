#!/usr/bin/env bash
#
# Put a previously archived Claudian build back into the plugin folder.
#
#   bin/rollback.sh                    back to the previous release for the target
#   bin/rollback.sh --list             show every archived release
#   bin/rollback.sh --to NAME          back to a specific release
#   bin/rollback.sh --target DIR       act on a different plugin folder
#
# Copies three files. data.json (tab state) is never touched, so the rollback
# does not cost you a single tab.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib-common.sh"

TARGET="$DEFAULT_TARGET"
TO=""
LIST=0

while [ $# -gt 0 ]; do
  case "$1" in
    --list)   LIST=1; shift ;;
    --to)     TO="${2:?--to braucht einen Release-Namen}"; shift 2 ;;
    --target) TARGET="${2:?--target braucht einen Pfad}"; shift 2 ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)        die "Unbekannte Option: $1" ;;
  esac
done

[ -d "$RELEASES_DIR" ] || die "Kein Release-Archiv unter $RELEASES_DIR"

if [ "$LIST" = "1" ]; then
  current="$(cat "$CURRENT_FILE" 2>/dev/null || echo '')"
  for d in "$RELEASES_DIR"/*/; do
    name="$(basename "$d")"
    built="$(sed -n 's/^built *//p' "$d/BUILD-INFO.txt" 2>/dev/null || echo '?')"
    marker="  "
    [ "$name" = "$current" ] && marker="→ "
    printf '%s%-34s %s\n' "$marker" "$name" "$built"
  done
  exit 0
fi

if [ -z "$TO" ]; then
  # Previous entry for THIS target in the ledger that is not what is installed.
  [ -f "$HISTORY_FILE" ] || die "Keine HISTORY.tsv — Ziel explizit angeben: --to NAME (siehe --list)"
  installed_sha=""
  [ -f "$TARGET/main.js" ] && installed_sha="$(sha256_of "$TARGET/main.js")"

  TO="$(awk -F'\t' -v t="$TARGET" -v s="$installed_sha" '$2==t && $4!=s {last=$1} END {print last}' "$HISTORY_FILE")"
  [ -n "$TO" ] || die "Kein vorheriger Stand für $TARGET gefunden. Mit --list schauen, dann --to NAME."
fi

SRC="$RELEASES_DIR/$TO"
[ -d "$SRC" ] || die "Release nicht gefunden: $TO (bin/rollback.sh --list)"
for f in "${ARTIFACTS[@]}"; do
  [ -f "$SRC/$f" ] || die "Release $TO ist unvollständig, $f fehlt"
done

assert_target_untracked "$TARGET"

for f in "${ARTIFACTS[@]}"; do
  cp "$SRC/$f" "$TARGET/$f"
done

printf '%s\n' "$TO" > "$CURRENT_FILE"
history_append "$TO" "$TARGET" "$(sha256_of "$SRC/main.js")"

c_green "Rollback auf $TO → $TARGET"
sed -n 's/^commit *//p;s/^note *//p' "$SRC/BUILD-INFO.txt" 2>/dev/null | sed 's/^/  /'
reload_plugin_if_live "$TARGET"
