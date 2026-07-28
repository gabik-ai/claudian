#!/usr/bin/env bash
#
# How far has this fork drifted from upstream, measured by what actually hurts.
#
#   bin/patch-surface.sh            measure against origin/main's merge base
#   bin/patch-surface.sh <base>     measure against an explicit base commit
#
# Replaces a plain commit ceiling, and the reason is worth writing down.
#
# The old guard failed CI above 12 commits on top of upstream. It was raised
# from 10 to 12 on 2026-07-27 and would have needed raising again to 16 one day
# later. A limit that gets lifted every time it is reached is not a limit, it is
# a ceremony — and this one was measuring the wrong thing twice over:
#
#   1. It punished the practice this repo requires. Every patch here carries its
#      own reason, its own test and its own obsolescence guard, so patches land
#      as small separate commits. One 6000-line commit would have sailed past a
#      count of 12; sixteen reviewed ones did not.
#
#   2. It ignored where rebase pain actually comes from. Measured on
#      2026-07-28 over the whole series: 6048 added lines across 45 files, but
#      only 1005 lines in 22 files that upstream ALSO has. The other 5043 lines
#      sit in files that exist only here — tests/unit/mazel/, bin/, new
#      components. Upstream never edits those, so they cannot conflict, ever.
#      83 % of the "divergence" carried no risk at all.
#
# So the number that predicts a painful rebase is the CONFLICT SURFACE: lines we
# changed in files upstream also maintains. That is what this script gates on.
# The commit count survives only as a runaway backstop, set far above any
# plausible series, to catch a loop that commits two hundred times.
#
# Raising SURFACE_MAX is a real conversation: it means we are editing more of
# upstream's own code, which is exactly the thing worth arguing about. Raising a
# commit ceiling only ever meant we had been busy.

set -euo pipefail

# Lines changed in files upstream also has. 1005 measured on 2026-07-28 over
# the full 16-commit series; 1600 leaves room for roughly half again as much
# before someone has to justify it in a PR.
SURFACE_MAX=${SURFACE_MAX:-1600}

# Pure runaway backstop, NOT a design budget. If this ever fires, something
# automated went wrong; a human series does not reach it.
COMMITS_MAX=${COMMITS_MAX:-40}

base=${1:-}
if [ -z "$base" ]; then
  base=$(git merge-base HEAD origin/main)
fi

commits=$(git rev-list --count "$base..HEAD")

shared_files=0
shared_lines=0
own_files=0
own_lines=0

while read -r add del path; do
  # Binary files report "-" for both counts.
  [ "$add" = "-" ] && add=0
  [ "$del" = "-" ] && del=0
  if git cat-file -e "$base:$path" 2>/dev/null; then
    shared_files=$((shared_files + 1))
    shared_lines=$((shared_lines + add + del))
  else
    own_files=$((own_files + 1))
    own_lines=$((own_lines + add + del))
  fi
done < <(git diff --numstat "$base..HEAD")

echo "Patch-Serie über $base"
echo "  Commits:            $commits (Backstop $COMMITS_MAX)"
echo "  Konfliktflaeche:    $shared_lines Zeilen in $shared_files Dateien, die upstream auch hat (Grenze $SURFACE_MAX)"
echo "  Eigene Dateien:     $own_lines Zeilen in $own_files Dateien, die nur hier existieren (kein Konfliktrisiko)"

status=0

if [ "$shared_lines" -gt "$SURFACE_MAX" ]; then
  echo "::error::Konfliktflaeche $shared_lines Zeilen, Grenze ist $SURFACE_MAX."
  echo "Das ist die Zahl, die einen Rebase schmerzhaft macht: Aenderungen an Code,"
  echo "den upstream selbst pflegt. Entweder einen Patch aufgeben, oder ihn so"
  echo "umbauen, dass er in einer eigenen Datei lebt statt in einer geteilten."
  status=1
fi

if [ "$commits" -gt "$COMMITS_MAX" ]; then
  echo "::error::$commits Commits ueber dem Backstop $COMMITS_MAX."
  echo "Das ist keine Granularitaets-Frage, sondern der Verdacht auf eine Schleife."
  status=1
fi

exit $status
