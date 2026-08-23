#!/usr/bin/env bash
#
# Publish the full source tree to GitHub.
#
# The repository was seeded through the GitHub REST API, which is fine for a
# handful of files and impractical for a couple of megabytes of source. Run this
# from the root of the unpacked project archive and git will do in one round trip
# what the API would need hundreds of calls for.
#
# Usage:
#   ./scripts/push-all.sh                                  # SSH remote
#   ./scripts/push-all.sh <remote-url>                     # explicit remote
#
set -euo pipefail

REMOTE="${1:-git@github.com:n1kro-yeah/praxis.git}"
BRANCH="main"

if [ ! -f package.json ] || [ ! -d src ]; then
  echo "error: run this from the project root (the directory holding package.json and src/)" >&2
  exit 1
fi

if [ ! -d .git ]; then
  git init -q
  git branch -M "$BRANCH"
fi

if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$REMOTE"
else
  git remote add origin "$REMOTE"
fi

# Identity is only set when it is missing, so a configured global identity is
# left alone rather than silently overridden.
git config user.name  >/dev/null 2>&1 || git config user.name  "praxis"
git config user.email >/dev/null 2>&1 || git config user.email "praxis@localhost"

git add -A

if git diff --cached --quiet; then
  echo "nothing to commit; the working tree matches the index"
else
  git commit -q -m "Full source tree"
fi

# Force is deliberate. The remote holds an API-seeded subset of these same
# files; a merge would produce a pointless conflict resolution over content that
# is authoritative here.
git push --force -u origin "$BRANCH"

echo "pushed $(git rev-list --count HEAD) commit(s) to $REMOTE ($BRANCH)"
