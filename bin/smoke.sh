#!/usr/bin/env bash
#
# Prove that the plugin folder holds the build we think it holds, and that the
# build carries the mazel patches.
#
#   bin/smoke.sh                  check the live vault plugin folder
#   bin/smoke.sh --target DIR     check a different folder
#   bin/smoke.sh --strict         a skipped tier is a failure, not a warning
#
# Three tiers, and the script always says which ones actually ran. A skipped
# tier is never reported as a pass — that is how a smoke test lies.
#
#   1 artifact   files present, sane sizes, hash matches the archived release
#   2 bundle     the four mazel patches are structurally present in main.js
#   3 runtime    real DOM assertions inside a running Obsidian
#                (needs the Obsidian CLI: Einstellungen → Allgemein → Erweitert)

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib-common.sh"

TARGET="$DEFAULT_TARGET"
STRICT=0

while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="${2:?--target braucht einen Pfad}"; shift 2 ;;
    --strict) STRICT=1; shift ;;
    -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unbekannte Option: $1" ;;
  esac
done

FAILURES=0
SKIPPED=()
RAN=()

pass() { c_green "  ✓ $*"; }
fail() { c_red   "  ✗ $*"; FAILURES=$((FAILURES + 1)); }
skip() { c_yellow "  – $*"; }

# ── Tier 1: artifact ─────────────────────────────────────────────────────────
echo
echo "Stufe 1 — Artefakte in $TARGET"
RAN+=("artifact")

if [ ! -d "$TARGET" ]; then
  fail "Zielordner existiert nicht"
else
  for f in "${ARTIFACTS[@]}"; do
    if [ ! -f "$TARGET/$f" ]; then
      fail "$f fehlt"
    else
      size="$(wc -c < "$TARGET/$f" | tr -d ' ')"
      case "$f" in
        main.js)       [ "$size" -gt 1000000 ] || fail "main.js ist nur $size Bytes — kein Release-Build" ;;
        styles.css)    [ "$size" -gt 10000 ]   || fail "styles.css ist nur $size Bytes" ;;
        manifest.json) [ "$size" -gt 100 ]     || fail "manifest.json ist nur $size Bytes" ;;
      esac
      pass "$f ($size Bytes)"
    fi
  done

  # data.json must survive every deploy and rollback.
  if [ -f "$TARGET/data.json" ]; then
    pass "data.json unangetastet ($(wc -c < "$TARGET/data.json" | tr -d ' ') Bytes)"
  else
    c_dim "  · data.json nicht vorhanden (frische Installation)"
  fi

  # The installed bundle must be byte-identical to an archived release.
  if [ -f "$TARGET/main.js" ] && [ -f "$CURRENT_FILE" ]; then
    current="$(cat "$CURRENT_FILE")"
    archived="$RELEASES_DIR/$current/main.js"
    if [ -f "$archived" ]; then
      if cmp -s "$TARGET/main.js" "$archived"; then
        pass "identisch mit archiviertem Release $current"
      else
        fail "weicht vom archivierten Release $current ab — jemand hat daneben geschrieben"
      fi
    else
      skip "Release $current nicht im Archiv"
    fi
  fi
fi

# ── Tier 2: bundle ───────────────────────────────────────────────────────────
echo
echo "Stufe 2 — Patches im gebauten Bundle"
RAN+=("bundle")
if [ -f "$TARGET/main.js" ]; then
  if python3 "$REPO_ROOT/bin/assert-bundle.py" "$TARGET"; then
    :
  else
    FAILURES=$((FAILURES + $?))
  fi
else
  fail "kein main.js zum Prüfen"
fi

# ── Tier 3: runtime ──────────────────────────────────────────────────────────
echo
echo "Stufe 3 — Laufzeit in Obsidian"
if ! command -v obsidian >/dev/null 2>&1; then
  skip "Obsidian-CLI nicht verfügbar"
  c_dim "     einschalten: Obsidian → Einstellungen → Allgemein → Erweitert → CLI aktivieren"
  SKIPPED+=("runtime")
elif ! live_plugin_dir_is "$TARGET"; then
  # Without this guard the tier silently reports on whatever plugin the running
  # Obsidian happens to have loaded, which for a staging target is a different
  # build entirely. That is a smoke test that lies.
  skip "Ziel ist nicht der Plugin-Ordner des laufenden Vaults — Laufzeit sagt nichts über $TARGET"
  SKIPPED+=("runtime")
else
  RAN+=("runtime")
  runtime_out="$(obsidian eval code="$(cat "$REPO_ROOT/bin/runtime-assertions.js")" 2>&1 || true)"
  if printf '%s' "$runtime_out" | python3 -c '
import json, sys
raw = sys.stdin.read()
try:
    # The CLI prefixes its result with "=> ".
    start = raw.index("{")
    data = json.loads(raw[start:])
except Exception:
    print("  Antwort der CLI nicht lesbar:")
    print("  " + raw.strip()[:400])
    sys.exit(1)
bad = 0
for name, result in data.items():
    okay = result is True or (isinstance(result, dict) and result.get("ok"))
    detail = "" if okay else f"  {result}"
    print(("  \033[32m✓\033[0m " if okay else "  \033[31m✗\033[0m ") + name + detail)
    if not okay:
        bad += 1
sys.exit(1 if bad else 0)
'; then
    :
  else
    FAILURES=$((FAILURES + 1))
  fi
fi

# ── Verdict ──────────────────────────────────────────────────────────────────
echo
echo "Gelaufen:    ${RAN[*]}"
if [ "${#SKIPPED[@]}" -gt 0 ]; then
  c_yellow "Übersprungen: ${SKIPPED[*]}"
  if [ "$STRICT" = "1" ]; then
    c_red "--strict: eine übersprungene Stufe zählt als Fehler."
    FAILURES=$((FAILURES + 1))
  else
    c_yellow "Das Ergebnis deckt diese Stufe NICHT ab."
  fi
fi

echo
if [ "$FAILURES" -eq 0 ]; then
  c_green "Smoke-Test bestanden (${#RAN[@]} von 3 Stufen)."
  exit 0
fi
c_red "Smoke-Test fehlgeschlagen: $FAILURES Prüfung(en) rot."
c_dim "Rollback: bin/rollback.sh --target $TARGET"
exit 1
