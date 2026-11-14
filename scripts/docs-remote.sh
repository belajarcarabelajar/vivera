#!/usr/bin/env bash
# Build, test and deploy the docs site on the VPS, because nothing compiles on
# this laptop.
# Usage: scripts/docs-remote.sh test | build [--local] | deploy [--dry-run] [--local]
#                              | ship --local [--dry-run]
#   test     sync the working tree and run the crate tests
#   build    build the site from the exact HEAD commit, stamp it with
#            docs/version.json (commit, built_at), and check it. With --local,
#            VIVERA_DOCS_OUT=<dir> (empty or absent) receives a copy of the
#            checked dist.
#   deploy   build, then wrangler deploy; a real deploy needs
#            VIVERA_DOCS_DEPLOY_ACK=I_UNDERSTAND_THIS_CHANGES_LIVE
#            The live check is retried VIVERA_DOCS_LIVE_ATTEMPTS times (default
#            10), VIVERA_DOCS_LIVE_INTERVAL seconds apart (default 20).
#   ship     local only: deploy a dist built elsewhere (apps/docs/dist, whose
#            docs/version.json commit must equal HEAD) with the deploy half
#            only: no bun install, cargo or docs-gen. Same ack and token rules.
#   --local  run every step on this host instead of over ssh (a CI runner is
#            the build host). ~/cloudflare/.env is never read: a real deploy
#            needs the Cloudflare token in VIVERA_DOCS_CF_TOKEN, which is
#            removed from the environment and handed to the wrangler commands
#            only. CLOUDFLARE_ACCOUNT_ID passes through as is.
# VIVERA_DOCS_TARGET_DIR sets the cargo target dir in both modes (default
# /root/.cache/vivera-docs-target).
# Exit: 0 ok, 1 failure, 2 usage error.
set -euo pipefail

usage() { echo "usage: scripts/docs-remote.sh test | build [--local] | deploy [--dry-run] [--local] | ship --local [--dry-run]" >&2; exit 2; }
[ $# -ge 1 ] || usage
MODE="$1"
shift
DRY_RUN=0
LOCAL=0
case "$MODE" in
  test) [ $# -eq 0 ] || usage ;;
  build | deploy | ship)
    for arg in "$@"; do
      case "$arg" in
        --local)
          [ "$LOCAL" -eq 0 ] || usage
          LOCAL=1
          ;;
        --dry-run)
          { [ "$MODE" != build ] && [ "$DRY_RUN" -eq 0 ]; } || usage
          DRY_RUN=1
          ;;
        *) usage ;;
      esac
    done
    ;;
  *) usage ;;
esac
if [ "$MODE" = ship ] && [ "$LOCAL" -eq 0 ]; then
  usage
fi
DEPLOYS=0
if [ "$MODE" = deploy ] || [ "$MODE" = ship ]; then
  DEPLOYS=1
fi
OUT_DIR=
if [ "$MODE" = build ] && [ "$LOCAL" -eq 1 ]; then
  OUT_DIR="${VIVERA_DOCS_OUT:-}"
fi

# Taken out of the environment before anything runs, so bun install scripts,
# cargo build scripts and pagefind cannot read it; only wrangler gets it back.
CF_TOKEN=
export -n CF_TOKEN
if [ "$LOCAL" -eq 1 ]; then
  CF_TOKEN="${VIVERA_DOCS_CF_TOKEN:-}"
  unset VIVERA_DOCS_CF_TOKEN CLOUDFLARE_API_TOKEN
fi

# New Worker routes take up to a few minutes to propagate after wrangler deploy.
LIVE_ATTEMPTS="${VIVERA_DOCS_LIVE_ATTEMPTS:-10}"
LIVE_INTERVAL="${VIVERA_DOCS_LIVE_INTERVAL:-20}"
if [ "$DEPLOYS" -eq 1 ]; then
  if [[ ! "$LIVE_ATTEMPTS" =~ ^[1-9][0-9]*$ ]]; then
    echo "VIVERA_DOCS_LIVE_ATTEMPTS must be a positive integer, got: $LIVE_ATTEMPTS" >&2
    exit 2
  fi
  if [[ ! "$LIVE_INTERVAL" =~ ^[0-9]+$ ]]; then
    echo "VIVERA_DOCS_LIVE_INTERVAL must be a whole number of seconds, got: $LIVE_INTERVAL" >&2
    exit 2
  fi
fi

HOST="${VIVERA_VPS:-vps-bcb}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
# Each run gets its own directory on the shared VPS, so concurrent sessions do
# not clobber each other; the cargo target dir stays shared because cargo locks it.
WORK_DIR=
TARGET_DIR="${VIVERA_DOCS_TARGET_DIR:-/root/.cache/vivera-docs-target}"
LIVE_URL=https://vivera.belajarcarabelajar.com/docs/
DEPLOY_ACK=I_UNDERSTAND_THIS_CHANGES_LIVE
# Pinned to the release whose `rollback --message ... --yes` flags were checked.
WRANGLER=wrangler@4.151.1
# Sourced on the VPS only; set -a exports the token to wrangler without printing it.
CF_ENV='set -a; . ~/cloudflare/.env; set +a'
# An empty CF_ENV would leave "cd x; ; bunx", a bash syntax error.
if [ "$LOCAL" -eq 1 ]; then
  HOST=localhost
  CF_ENV=':'
fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SSH_OPTS=(-o BatchMode=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o ConnectTimeout=30)
LOG="${VIVERA_DOCS_LOG_DIR:-/tmp}/vivera-docs-remote-${MODE}-${STAMP}.log"

exec > >(tee -a "$LOG") 2>&1
TEE_PID=$!
finish() {
  local rc=$?
  [ "$rc" -eq 0 ] || rc=1
  if [ -n "$WORK_DIR" ]; then
    if remote "rm -rf -- $WORK_DIR"; then
      echo "cleanup: removed $HOST:$WORK_DIR"
    else
      echo "cleanup: could not remove $HOST:$WORK_DIR"
    fi
  fi
  echo "log: $LOG"
  # Close our end of the pipe and wait, so tee flushes before the shell returns.
  exec >&- 2>&-
  wait "$TEE_PID" 2>/dev/null || true
  exit "$rc"
}
trap finish EXIT
echo "log: $LOG"

if [ "$DEPLOYS" -eq 1 ] && [ "$DRY_RUN" -eq 0 ] && [ "${VIVERA_DOCS_DEPLOY_ACK:-}" != "$DEPLOY_ACK" ]; then
  echo "deploy: refused, a real deploy changes the live site."
  echo "Set VIVERA_DOCS_DEPLOY_ACK=$DEPLOY_ACK to deploy, or pass --dry-run."
  exit 1
fi

if [ "$LOCAL" -eq 1 ] && [ "$DEPLOYS" -eq 1 ] && [ "$DRY_RUN" -eq 0 ] && [ -z "$CF_TOKEN" ]; then
  echo "deploy: refused, a real --local deploy needs the Cloudflare token in VIVERA_DOCS_CF_TOKEN."
  exit 1
fi

if [ ! -f "$ROOT/apps/docs/Cargo.toml" ]; then
  echo "apps/docs/Cargo.toml missing"
  exit 1
fi

# Non-interactive ssh as root does not source the profile that puts cargo on PATH.
# Single quotes on purpose: $HOME and $PATH expand in the shell that runs it.
# shellcheck disable=SC2016
PRELUDE='export PATH="$HOME/.cargo/bin:$HOME/.bun/bin:$PATH"; set -eu; '
remote() {
  if [ "$LOCAL" -eq 1 ]; then
    bash -c "$PRELUDE$1"
  else
    # shellcheck disable=SC2029
    ssh "${SSH_OPTS[@]}" "$HOST" "$PRELUDE$1"
  fi
}

# The token rides in the environment of this one bash process, never in its
# arguments, where ps would show it.
remote_wrangler() {
  if [ "$LOCAL" -eq 1 ] && [ -n "$CF_TOKEN" ]; then
    CLOUDFLARE_API_TOKEN="$CF_TOKEN" bash -c "$PRELUDE$1"
  else
    remote "$1"
  fi
}

make_work_dir() {
  local made
  made="$(remote "mktemp -d /tmp/vivera-docs-$MODE-$STAMP-XXXXXX")" || {
    echo "remote: mktemp failed on $HOST"
    exit 1
  }
  # The path is later spliced into a remote rm -rf, so anything else is refused.
  if [[ ! "$made" =~ ^/tmp/vivera-docs-[a-z]+-[0-9]{8}T[0-9]{6}Z-[A-Za-z0-9]{6}$ ]]; then
    echo "remote: unexpected mktemp output: $made"
    exit 1
  fi
  WORK_DIR="$made"
  echo "work dir: $HOST:$WORK_DIR"
}

sync_up() {
  # Local generated and build output is not uploaded; the VPS regenerates it.
  rsync -az -e "ssh ${SSH_OPTS[*]}" \
    --exclude=.git --exclude=node_modules --exclude=graphify-out \
    --exclude=/apps/docs/target --exclude=/apps/docs/dist \
    --exclude=/apps/docs/content/en --exclude=/apps/docs/static/generated \
    "$ROOT/" "$HOST:$WORK_DIR/"
}

run_test() {
  make_work_dir
  echo "sync: $ROOT -> $HOST:$WORK_DIR"
  sync_up
  remote "cd $WORK_DIR && bun install --frozen-lockfile && bun scripts/docs-gen.mjs --write"
  if [ ! -f "$ROOT/apps/docs/Cargo.lock" ]; then
    remote "cd $WORK_DIR/apps/docs && cargo generate-lockfile"
    rsync -a -e "ssh ${SSH_OPTS[*]}" "$HOST:$WORK_DIR/apps/docs/Cargo.lock" "$ROOT/apps/docs/Cargo.lock"
    echo "copied back: apps/docs/Cargo.lock"
  fi
  remote "cd $WORK_DIR/apps/docs && CARGO_TARGET_DIR=$TARGET_DIR cargo test --locked"
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
  if [ -n "$OUT_DIR" ] && [ -e "$OUT_DIR" ] && { [ ! -d "$OUT_DIR" ] || [ -n "$(ls -A -- "$OUT_DIR")" ]; }; then
    echo "build: VIVERA_DOCS_OUT must be an empty or absent directory: $OUT_DIR"
    exit 1
  fi
  require_clean
  make_work_dir
  echo "upload: git archive $(git -C "$ROOT" rev-parse --short HEAD) -> $HOST:$WORK_DIR"
  # .gitattributes marks apps/ export-ignore to keep it out of release archives.
  # Archiving the HEAD:apps subtree adds it back, because the root pattern does
  # not apply inside a subtree archive; --ignore-zeros reads both tar streams.
  {
    git -C "$ROOT" archive --format=tar HEAD
    git -C "$ROOT" archive --format=tar --prefix=apps/ HEAD:apps
  } | remote "tar -x --ignore-zeros -C $WORK_DIR"

  echo "build: install and generate"
  remote "cd $WORK_DIR && bun install --frozen-lockfile"
  remote "cd $WORK_DIR && bun scripts/docs-gen.mjs --check --scope all"
  remote "cd $WORK_DIR && bun scripts/docs-gen.mjs --write"

  echo "build: maudit"
  remote "cd $WORK_DIR/apps/docs && export CARGO_TARGET_DIR=$TARGET_DIR && if command -v maudit >/dev/null 2>&1; then maudit build; else cargo run --release --locked; fi"
  remote "cd $WORK_DIR/apps/docs && mkdir -p dist/docs/generated && cp -R static/generated/. dist/docs/generated/"

  echo "build: search index and site check"
  remote "cd $WORK_DIR/apps/docs && bunx pagefind@1.5.2 --site dist --output-path dist/docs/pagefind"
  write_version_stamp
  remote "cd $WORK_DIR && bun scripts/docs-site-check.mjs apps/docs/dist"
  if [ -n "$OUT_DIR" ]; then
    mkdir -p -- "$OUT_DIR"
    cp -R -- "$WORK_DIR/apps/docs/dist/." "$OUT_DIR/"
    echo "build: dist copied to $OUT_DIR"
  fi
  echo "build: ok"
}

# The work dir is a git archive without .git, so the SHA comes from ROOT.
write_version_stamp() {
  local sha built_at
  sha="$(git -C "$ROOT" rev-parse HEAD)"
  if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
    echo "build: unexpected HEAD: $sha"
    exit 1
  fi
  built_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "build: version stamp $sha"
  remote "cd $WORK_DIR/apps/docs && printf '%s\n' '{\"commit\": \"$sha\", \"built_at\": \"$built_at\"}' > dist/docs/version.json"
}

run_deploy() {
  run_build
  deploy_built
}

# The workflow builds in a job that never holds the token and hands the dist to
# this one, so ship runs no bun install, cargo build or docs-gen. It works on a
# copy because cleanup removes WORK_DIR.
run_ship() {
  local dist="$ROOT/apps/docs/dist" head stamped
  if [ ! -f "$dist/docs/version.json" ]; then
    echo "ship: $dist/docs/version.json missing; put the build artifact in apps/docs/dist first"
    exit 1
  fi
  head="$(git -C "$ROOT" rev-parse HEAD)"
  stamped="$(sed -n 's/.*"commit": *"\([0-9a-f]*\)".*/\1/p' "$dist/docs/version.json")"
  if [ "$stamped" != "$head" ]; then
    echo "ship: the dist was built from ${stamped:-an unknown commit}, which does not match HEAD $head"
    exit 1
  fi
  make_work_dir
  mkdir -p "$WORK_DIR/apps/docs"
  cp -R -- "$ROOT/apps/docs/wrangler.json" "$dist" "$WORK_DIR/apps/docs/"
  echo "ship: dist of $stamped copied to $WORK_DIR"
  deploy_built
}

# The deploy half shared by deploy and ship: dry run, deploy, live check, rollback.
deploy_built() {
  echo "deploy: wrangler dry run"
  remote_wrangler "cd $WORK_DIR/apps/docs; $CF_ENV; bunx $WRANGLER deploy --dry-run"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "deploy: dry run only, nothing changed on the live site"
    return
  fi

  echo "deploy: wrangler deploy"
  remote_wrangler "cd $WORK_DIR/apps/docs; $CF_ENV; bunx $WRANGLER deploy"
  echo "deploy: live check $LIVE_URL"
  local live_rc=0 rollback_rc=0 list_rc=0 count=0
  live_check_with_retries || live_rc=$?
  if [ "$live_rc" -eq 0 ]; then
    echo "deploy: ok, live check passed"
    return
  fi

  echo "deploy: live check failed on all $LIVE_ATTEMPTS attempts"
  count="$(deployment_count)" || list_rc=$?
  if [ "$list_rc" -ne 0 ]; then
    echo "rollback: skipped, could not list deployments (exit $list_rc); check with wrangler deployments list and roll back by hand"
  elif [ "$count" -gt 1 ]; then
    echo "deploy: $count deployments listed, rolling back"
    remote_wrangler "cd $WORK_DIR/apps/docs; $CF_ENV; bunx $WRANGLER rollback --message \"smoke failed\" --yes" || rollback_rc=$?
    echo "rollback: exit $rollback_rc"
  else
    echo "rollback: skipped, nothing to roll back to because this is the first deployment of the Worker"
    echo "rollback: the new Worker serves the docs routes; remove the docs routes by hand in the Cloudflare dashboard if they must go"
  fi
  echo "live check: exit $live_rc"
  exit 1
}

live_check_with_retries() {
  local attempt=1 rc
  while :; do
    rc=0
    bun "$ROOT/scripts/docs-site-check.mjs" --live "$LIVE_URL" || rc=$?
    echo "live check: attempt $attempt/$LIVE_ATTEMPTS exit $rc"
    if [ "$rc" -eq 0 ] || [ "$attempt" -ge "$LIVE_ATTEMPTS" ]; then
      return "$rc"
    fi
    echo "live check: waiting ${LIVE_INTERVAL}s for the routes to propagate"
    sleep "$LIVE_INTERVAL"
    attempt=$((attempt + 1))
  done
}

# wrangler rollback needs an earlier deployment; on the first one it only fails.
deployment_count() {
  local listed
  listed="$(remote_wrangler "cd $WORK_DIR/apps/docs; $CF_ENV; bunx $WRANGLER deployments list --json")" || return
  # Each deployment object has one top-level "id"; its versions use "version_id".
  { grep -o '"id":' <<<"$listed" || true; } | wc -l | tr -d ' '
}

case "$MODE" in
  test) run_test ;;
  build) run_build ;;
  deploy) run_deploy ;;
  ship) run_ship ;;
esac
