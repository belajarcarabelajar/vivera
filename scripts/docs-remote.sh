#!/usr/bin/env bash
# Build and test the docs site on the VPS, because nothing compiles on this
# laptop. Usage: scripts/docs-remote.sh test
set -euo pipefail

usage() { echo "usage: scripts/docs-remote.sh test" >&2; exit 2; }
[ $# -eq 1 ] || usage
MODE="$1"
case "$MODE" in test) ;; *) usage ;; esac

HOST="${VIVERA_VPS:-vps-bcb}"
REMOTE_DIR=/tmp/vivera-docs-build
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SSH_OPTS=(-o BatchMode=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o ConnectTimeout=30)
LOG="/tmp/vivera-docs-remote-${MODE}-$(date -u +%Y%m%dT%H%M%SZ).log"

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
  remote "cd $REMOTE_DIR/apps/docs && CARGO_TARGET_DIR=/root/.cache/vivera-docs-target cargo test --locked"
}

case "$MODE" in
  test) run_test ;;
esac
