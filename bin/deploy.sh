#!/usr/bin/env bash
#
# Build the mazel fork and install it into an Obsidian plugin folder.
#
#   bin/deploy.sh                     build + install into the live vault plugin
#   bin/deploy.sh --target DIR        install somewhere else (staging, tests)
#   bin/deploy.sh --no-build          install the artifacts already in the repo
#   bin/deploy.sh --dry-run           show what would happen, touch nothing
#
# Every build is archived under
#   ~/Library/Application Support/claudian-releases/<version>-<sha>[-dirty]/
# and appended to HISTORY.tsv, which is what bin/rollback.sh walks backwards.
# Deliberately copies instead of symlinking: the vault repo tracks this folder,
# Obsidian's FSEvents watcher does not traverse symlinks, and the backup agent
# runs every 10 minutes.
#
# data.json (tab state) is never touched.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib-common.sh"

TARGET="$DEFAULT_TARGET"
DO_BUILD=1
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --target)   TARGET="${2:?--target braucht einen Pfad}"; shift 2 ;;
    --no-build) DO_BUILD=0; shift ;;
    --dry-run)  DRY_RUN=1; shift ;;
    -h|--help)  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)          die "Unbekannte Option: $1" ;;
  esac
done

cd "$REPO_ROOT"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
SHA="$(git rev-parse --short HEAD)"
DIRTY=""
git diff --quiet HEAD -- src manifest.json styles 2>/dev/null || DIRTY="-dirty"

if [ "$DO_BUILD" = "1" ]; then
  PATH="$(resolve_node):$PATH"
  export PATH
  c_dim "Node: $(node -v)   Branch: $BRANCH   Commit: $SHA$DIRTY"

  c_dim "typecheck + lint + tests …"
  npm run typecheck
  npm run lint
  npm test >/dev/null

  c_dim "build …"
  npm run build >/dev/null
fi

for f in "${ARTIFACTS[@]}"; do
  [ -f "$REPO_ROOT/$f" ] || die "Build-Artefakt fehlt: $f (ohne --no-build bauen)"
done

VERSION="$(manifest_field "$REPO_ROOT/manifest.json" version)"
PLUGIN_ID="$(manifest_field "$REPO_ROOT/manifest.json" id)"
[ "$PLUGIN_ID" = "claudian" ] || die "manifest.id ist '$PLUGIN_ID', erwartet 'claudian' (Fork-Identitäts-Patch fehlt)"

RELEASE_NAME="${VERSION}-${SHA}${DIRTY}"
RELEASE_DIR="$RELEASES_DIR/$RELEASE_NAME"
MAIN_SHA="$(sha256_of "$REPO_ROOT/main.js")"

if [ "$DRY_RUN" = "1" ]; then
  c_yellow "DRY RUN — nichts wird geschrieben"
  echo "  Release : $RELEASE_DIR"
  echo "  Ziel    : $TARGET"
  echo "  main.js : $(wc -c < "$REPO_ROOT/main.js" | tr -d ' ') Bytes, sha256 ${MAIN_SHA:0:12}…"
  exit 0
fi

assert_target_untracked "$TARGET"

# 1. Archive the build.
mkdir -p "$RELEASE_DIR"
for f in "${ARTIFACTS[@]}"; do
  cp "$REPO_ROOT/$f" "$RELEASE_DIR/$f"
done

{
  echo "release      $RELEASE_NAME"
  echo "built        $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "branch       $BRANCH"
  echo "commit       $(git rev-parse HEAD)"
  echo "dirty        $([ -n "$DIRTY" ] && echo yes || echo no)"
  echo "upstream     $(git rev-parse --short "$(git merge-base HEAD origin/main 2>/dev/null || echo HEAD)" 2>/dev/null || echo unknown)"
  echo "node         $(node -v 2>/dev/null || echo n/a)"
  echo "sha256:main  $MAIN_SHA"
  echo "sha256:css   $(sha256_of "$REPO_ROOT/styles.css")"
  echo "manifest.id  $PLUGIN_ID"
  echo "--- mazel patches on top of origin/main ---"
  git log --oneline "$(git merge-base HEAD origin/main 2>/dev/null || echo HEAD)..HEAD" 2>/dev/null || echo "(unbekannt)"
} > "$RELEASE_DIR/BUILD-INFO.txt"

# 2. Preserve whatever is installed right now, so a rollback always has a
#    previous state even for a target that was never deployed by this script.
if [ -f "$TARGET/main.js" ] && [ ! -f "$RELEASES_DIR/pre-deploy-backup/BUILD-INFO.txt" ]; then
  PREV_SHA="$(sha256_of "$TARGET/main.js")"
  if [ "$PREV_SHA" != "$MAIN_SHA" ]; then
    BACKUP_DIR="$RELEASES_DIR/pre-deploy-$(date -u +%Y%m%dT%H%M%SZ)"
    mkdir -p "$BACKUP_DIR"
    for f in "${ARTIFACTS[@]}"; do
      [ -f "$TARGET/$f" ] && cp "$TARGET/$f" "$BACKUP_DIR/$f"
    done
    printf 'release      %s\nbuilt        %s\nnote         Zustand VOR dem Deploy von %s\nsha256:main  %s\n' \
      "$(basename "$BACKUP_DIR")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$RELEASE_NAME" "$PREV_SHA" \
      > "$BACKUP_DIR/BUILD-INFO.txt"
    history_append "$(basename "$BACKUP_DIR")" "$TARGET" "$PREV_SHA"
    c_dim "Vorheriger Stand gesichert: $(basename "$BACKUP_DIR")"
  fi
fi

# 3. Install.
for f in "${ARTIFACTS[@]}"; do
  cp "$RELEASE_DIR/$f" "$TARGET/$f"
done

printf '%s\n' "$RELEASE_NAME" > "$CURRENT_FILE"
history_append "$RELEASE_NAME" "$TARGET" "$MAIN_SHA"

c_green "Deployed $RELEASE_NAME → $TARGET"
reload_plugin_if_live "$TARGET"
c_dim "Rollback: bin/rollback.sh --target $TARGET"
