#!/usr/bin/env bash
# Shared helpers for bin/deploy.sh, bin/rollback.sh and bin/smoke.sh.
# Sourced, never executed directly.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASES_DIR="${CLAUDIAN_RELEASES_DIR:-$HOME/Library/Application Support/claudian-releases}"
HISTORY_FILE="$RELEASES_DIR/HISTORY.tsv"
CURRENT_FILE="$RELEASES_DIR/CURRENT"
DEFAULT_TARGET="${CLAUDIAN_PLUGIN_DIR:-$HOME/Documents/mazel-vault/.obsidian/plugins/claudian}"

# The three files that make up a plugin build. data.json is user state and is
# never touched by any script here.
ARTIFACTS=(main.js styles.css manifest.json)

c_red()   { printf '\033[31m%s\033[0m\n' "$*"; }
c_green() { printf '\033[32m%s\033[0m\n' "$*"; }
c_yellow(){ printf '\033[33m%s\033[0m\n' "$*"; }
c_dim()   { printf '\033[2m%s\033[0m\n' "$*"; }

die() { c_red "FEHLER: $*" >&2; exit 1; }

# Resolve a Node that satisfies the repo's engines field (>=24 <25).
# The machine default is Node 26, which the build refuses.
resolve_node() {
  local want major candidate
  want="$(cat "$REPO_ROOT/.node-version" 2>/dev/null || echo 24)"
  major="${want%%.*}"

  for candidate in \
    "/opt/homebrew/opt/node@${major}/bin" \
    "/usr/local/opt/node@${major}/bin" \
    "$HOME/.nvm/versions/node/v${want}/bin"
  do
    if [ -x "$candidate/node" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done

  # Fall back to whatever is on PATH, but only if it is in range.
  if command -v node >/dev/null 2>&1; then
    local have
    have="$(node -v | sed 's/^v//' | cut -d. -f1)"
    if [ "$have" = "$major" ]; then
      printf '%s' "$(dirname "$(command -v node)")"
      return 0
    fi
  fi

  die "Kein Node ${major}.x gefunden. Installieren mit: brew install node@${major}"
}

sha256_of() { shasum -a 256 "$1" | cut -d' ' -f1; }

manifest_field() {
  # $1 = file, $2 = field
  python3 -c "import json,sys;print(json.load(open(sys.argv[1]))[sys.argv[2]])" "$1" "$2"
}

# Refuse to write into a directory whose artifacts are tracked by a git repo.
# Otherwise every deploy produces a multi-megabyte diff in the vault repo and
# the 10-minute backup agent fights the deploy.
assert_target_untracked() {
  local target="$1" f tracked=()
  [ -d "$target" ] || die "Zielordner existiert nicht: $target"
  git -C "$target" rev-parse --show-toplevel >/dev/null 2>&1 || return 0

  for f in "${ARTIFACTS[@]}"; do
    if git -C "$target" ls-files --error-unmatch "$f" >/dev/null 2>&1; then
      tracked+=("$f")
    fi
  done

  if [ "${#tracked[@]}" -gt 0 ]; then
    c_red "Die Build-Artefakte sind im Vault-Git getrackt: ${tracked[*]}"
    c_yellow "Einmalig untracken, dann erneut deployen:"
    printf '\n  cd %q\n  git rm --cached %s\n  printf "%%s\\n" %s >> .gitignore\n  git commit -m "chore(claudian): build artifacts untracked, deploy schreibt sie"\n\n' \
      "$(git -C "$target" rev-parse --show-toplevel)" \
      "$(printf '%q ' "${tracked[@]/#/.obsidian/plugins/claudian/}")" \
      "$(printf '%q ' "${tracked[@]/#/.obsidian/plugins/claudian/}")"
    exit 2
  fi
}

# True only when $1 is the plugin folder of the vault the running Obsidian has
# open. Runtime assertions are meaningless for any other target — they would
# describe the loaded plugin, not the one we just wrote.
live_plugin_dir_is() {
  local target="$1" base
  command -v obsidian >/dev/null 2>&1 || return 1
  base="$(obsidian eval code='app.vault.adapter.basePath' 2>/dev/null | sed 's/^=> *//;s/^"//;s/"$//' | tail -1)"
  [ -n "$base" ] || return 1
  [ "$(cd "$target" 2>/dev/null && pwd -P)" = "$(cd "$base/.obsidian/plugins/claudian" 2>/dev/null && pwd -P)" ]
}

# Reload the plugin in place, so a deploy takes effect without touching the UI.
reload_plugin_if_live() {
  local target="$1"
  live_plugin_dir_is "$target" || return 0
  if obsidian plugin:reload id=claudian >/dev/null 2>&1; then
    c_dim "Plugin in Obsidian neu geladen (obsidian plugin:reload)."
  else
    c_yellow "Automatischer Reload fehlgeschlagen — Plugin in Obsidian aus- und wieder einschalten."
  fi
}

history_append() {
  # release_dir <TAB> target <TAB> iso_timestamp <TAB> sha256(main.js)
  mkdir -p "$RELEASES_DIR"
  printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$3" >> "$HISTORY_FILE"
}
