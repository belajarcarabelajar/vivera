#!/usr/bin/env bash
# Build, test and deploy the docs site on the VPS, because nothing compiles on
# this laptop.
# Usage: scripts/docs-remote.sh test | build | deploy [--dry-run]
#   test     sync the working tree and run the crate tests
#   build    build the site from the exact HEAD commit and check it
#   deploy   build, then wrangler deploy; a real deploy needs
#            VIVERA_DOCS_DEPLOY_ACK=I_UNDERSTAND_THIS_CHANGES_LIVE
# Exit: 0 ok, 1 failure, 2 usage error.
set -euo pipefail

usage() { echo "usage: scripts/docs-remote.sh test | build | deploy [--dry-run]" >&2; exit 2; }
[ $# -ge 1 ] || usage
MODE="$1"
shift
DRY_RUN=0
case "$MODE" in
  test | build) [ $# -eq 0 ] || usage ;;
  deploy)
    if [ $# -eq 1 ] && [ "$1" = --dry-run ]; then
      DRY_RUN=1
    elif [ $# -ne 0 ]; then
      usage
    fi
    ;;
  *) usage ;;
esac

HOST="${VIVERA_VPS:-vps-bcb}"
REMOTE_DIR=/tmp/vivera-docs-build
RELEASE_DIR=/tmp/vivera-docs-release
TARGET_DIR=/root/.cache/vivera-docs-target
LIVE_URL=https://vivera.belajarcarabelajar.com/docs/
DEPLOY_ACK=I_UNDERSTAND_THIS_CHANGES_LIVE
# Sourced on the VPS only; set -a exports the token to wrangler without printing it.
CF_ENV='set -a; . ~/cloudflare/.env; set +a'
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SSH_OPTS=(-o BatchMode=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o ConnectTimeout=30)
LOG="${VIVERA_DOCS_LOG_DIR:-/tmp}/vivera-docs-remote-${MODE}-$(date -u +%Y%m%dT%H%M%SZ).log"

exec > >(tee -a "$LOG") 2>&1
TEE_PID=$!
finish() {
  local rc=$?
  [ "$rc" -eq 0 ] || rc=1
  echo "log: $LOG"
  # Close our end of the pipe and wait, so tee flushes before the shell returns.
  exec >&- 2>&-
  wait "$TEE_PID" 2>/dev/null || true
  exit "$rc"
}
trap finish EXIT
echo "log: $LOG"

if [ "$MODE" = deploy ] && [ "$DRY_RUN" -eq 0 ] && [ "${VIVERA_DOCS_DEPLOY_ACK:-}" != "$DEPLOY_ACK" ]; then
  echo "deploy: refused, a real deploy changes the live site."
  echo "Set VIVERA_DOCS_DEPLOY_ACK=$DEPLOY_ACK to deploy, or pass --dry-run."
  exit 1
fi

if [ ! -f "$ROOT/apps/docs/Cargo.toml" ]; then
  echo "apps/docs/Cargo.toml missing"
  exit 1
fi

# Non-interactive ssh as root does not source the profile that puts cargo on PATH.
remote() {
  # shellcheck disable=SC2029
  ssh "${SSH_OPTS[@]}" "$HOST" \
    "export PATH=\"\$HOME/.cargo/bin:\$HOME/.bun/bin:\$PATH\"; set -eu; $1"
}

sync_up() {
  # Generated and build output stay on the VPS; excluded paths survive --delete.
  rsync -az --delete -e "ssh ${SSH_OPTS[*]}" \
    --exclude=.git --exclude=node_modules --exclude=graphify-out \
    --exclude=/apps/docs/target --exclude=/apps/docs/dist \
    --exclude=/apps/docs/content/en --exclude=/apps/docs/static/generated \
    "$ROOT/" "$HOST:$REMOTE_DIR/"
}

run_test() {
  echo "sync: $ROOT -> $HOST:$REMOTE_DIR"
  sync_up
  remote "cd $REMOTE_DIR && bun install --frozen-lockfile && bun scripts/docs-gen.mjs --write"
  if [ ! -f "$ROOT/apps/docs/Cargo.lock" ]; then
    remote "cd $REMOTE_DIR/apps/docs && cargo generate-lockfile"
    rsync -a -e "ssh ${SSH_OPTS[*]}" "$HOST:$REMOTE_DIR/apps/docs/Cargo.lock" "$ROOT/apps/docs/Cargo.lock"
    echo "copied back: apps/docs/Cargo.lock"
  fi
  remote "cd $REMOTE_DIR/apps/docs && CARGO_TARGET_DIR=$TARGET_DIR cargo test --locked"
}

require_clean() {
  local status dirty
  status="$(git -C "$ROOT" status --porcelain)"
  # A session worktree links node_modules as a symlink, which the
  # `node_modules/` ignore pattern does not match; it is never part of HEAD.
  dirty="$(printf '%s\n' "$status" | grep -v -E '^\?\? node_modules/?$' | grep -v '^$' || true)"
  if [ -n "$dirty" ]; then
    echo "build: the tree is not clean, and the build ships HEAD only. Commit or remove:"
    printf '%s\n' "$dirty"
    exit 1
  fi
}

run_build() {
  require_clean
  echo "upload: git archive $(git -C "$ROOT" rev-parse --short HEAD) -> $HOST:$RELEASE_DIR"
  # .gitattributes marks apps/ export-ignore to keep it out of release archives.
  # Archiving the HEAD:apps subtree adds it back, because the root pattern does
  # not apply inside a subtree archive; --ignore-zeros reads both tar streams.
  {
    git -C "$ROOT" archive --format=tar HEAD
    git -C "$ROOT" archive --format=tar --prefix=apps/ HEAD:apps
  } | remote "rm -rf $RELEASE_DIR && mkdir -p $RELEASE_DIR && tar -x --ignore-zeros -C $RELEASE_DIR"

  echo "build: install and generate"
  remote "cd $RELEASE_DIR && bun install --frozen-lockfile"
  remote "cd $RELEASE_DIR && bun scripts/docs-gen.mjs --check --scope all"
  remote "cd $RELEASE_DIR && bun scripts/docs-gen.mjs --write"

  echo "build: maudit"
  remote "cd $RELEASE_DIR/apps/docs && export CARGO_TARGET_DIR=$TARGET_DIR && if command -v maudit >/dev/null 2>&1; then maudit build; else cargo run --release --locked; fi"
  remote "cd $RELEASE_DIR/apps/docs && mkdir -p dist/docs/generated && cp -R static/generated/. dist/docs/generated/"

  echo "build: search index and site check"
  remote "cd $RELEASE_DIR/apps/docs && bunx pagefind@1.5.2 --site dist --output-path dist/docs/pagefind"
  remote "cd $RELEASE_DIR && bun scripts/docs-site-check.mjs apps/docs/dist"
  echo "build: ok, $HOST:$RELEASE_DIR/apps/docs/dist"
}

run_deploy() {
  run_build
  echo "deploy: wrangler dry run"
  remote "cd $RELEASE_DIR/apps/docs; $CF_ENV; bunx wrangler deploy --dry-run"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "deploy: dry run only, nothing changed on the live site"
    return
  fi

  echo "deploy: wrangler deploy"
  remote "cd $RELEASE_DIR/apps/docs; $CF_ENV; bunx wrangler deploy"
  echo "deploy: live check $LIVE_URL"
  local live_rc=0 rollback_rc=0
  bun "$ROOT/scripts/docs-site-check.mjs" --live "$LIVE_URL" || live_rc=$?
  if [ "$live_rc" -eq 0 ]; then
    echo "deploy: ok, live check passed"
    return
  fi

  echo "deploy: live check failed, rolling back"
  remote "cd $RELEASE_DIR/apps/docs; $CF_ENV; bunx wrangler rollback --message \"smoke failed\" --yes" || rollback_rc=$?
  echo "live check: exit $live_rc"
  echo "rollback: exit $rollback_rc"
  exit 1
}

case "$MODE" in
  test) run_test ;;
  build) run_build ;;
  deploy) run_deploy ;;
esac
