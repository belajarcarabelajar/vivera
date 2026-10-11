#!/usr/bin/env bash
# install.sh - Plant the Vivera skill farm: symlink the Ultimate All-in-One AI Coding Agent Skill into every harness
# This file parses arguments and dispatches; the work lives in scripts/install/*.sh (sourced below).
set -euo pipefail

# The installer writes under HOME, and in this checkout the relative links of skills/super-ultra-code-plan
# and, in a git checkout of its own, core.hooksPath. Without HOME `set -u` would stop later with an
# unbound variable and exit 1.
if [ -z "${HOME:-}" ]; then
  echo "install.sh: HOME is not set" >&2
  exit 2
fi

# A CDPATH would make every `cd` below print or resolve somewhere else.
unset CDPATH

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The entry lists are TAB separated, one per line, so a HOME or checkout path holding a tab or a newline
# cannot be told apart from the list around it. Refused before anything is printed or touched.
case "$HOME$REPO_DIR" in
  *$'\n'* | *$'\t'*)
    echo "install.sh: HOME and the checkout path must not contain a newline or a tab" >&2
    exit 2
    ;;
esac

MASTER_FILE="$REPO_DIR/Super Ultra Code Plan Implementation.md"
DRY_RUN=false
COPY_MODE=false
TIER=standard
MODE=install
ONLY=""
SKIP=""

# Sourced first because usage lists the target ids from the table in targets.sh.
# shellcheck source=scripts/install/lib.sh
. "$REPO_DIR/scripts/install/lib.sh"
# shellcheck source=scripts/install/place.sh
. "$REPO_DIR/scripts/install/place.sh"
# shellcheck source=scripts/install/sprites.sh
. "$REPO_DIR/scripts/install/sprites.sh"
# shellcheck source=scripts/install/prereq.sh
. "$REPO_DIR/scripts/install/prereq.sh"
# shellcheck source=scripts/install/targets.sh
. "$REPO_DIR/scripts/install/targets.sh"
# shellcheck source=scripts/install/check.sh
. "$REPO_DIR/scripts/install/check.sh"
# shellcheck source=scripts/install/update.sh
. "$REPO_DIR/scripts/install/update.sh"
# shellcheck source=scripts/install/uninstall.sh
. "$REPO_DIR/scripts/install/uninstall.sh"

usage() {
  cat <<'EOF'
Usage: ./install.sh [--tier minimal|standard|full] [--only ID,ID] [--skip ID,ID] [--copy] [--dry-run]
                    [--check | --update | --uninstall] [-h]
  --tier T      prerequisite level, default standard. The tool table is scripts/install/tiers.tsv.
                  minimal   requires no tool; links the skills only (no sprite agents, no git hooks)
                  standard  requires git and bun
                  full      also requires gh and tgrep
  --only ID,ID  install only these targets, even when the harness is not detected
  --skip ID,ID  leave these targets out; wins over --only
  --copy        copy the files instead of linking them, marked with .vivera-managed (needs cmp and diff)
  --dry-run     print what would be done and write nothing
  --check       report whether the install is current and change nothing (exit 0 current, 1 problems,
                2 nothing to check); needs no bun and no git
  --update      bring the install in line with this checkout: repoint stale links, refresh copies, prune
  --uninstall   remove what the installer made and put the newest backup back; needs no bun and no git
  -h, --help    print this text
EOF
  echo "Targets, in install order: $(valid_target_list)"
  cat <<'EOF'
Always installed: ~/.config/ai and ~/.agents/skills. Every other harness is installed when it is
detected (its directory under your home or its CLI on PATH) or named with --only.
A file or directory that is already there and is not the installer's is moved to <name>.vivera-bak-<time>.
At standard and full, a tool the chosen tier does not require prints one warning naming what is lost and is skipped; at minimal it is silent.
TinyFish web-evidence rules ship inside the master skill; no extra skill is deployed.
Exit codes: 0 success or current, 1 failure (a required tool is missing, or --check found a problem),
2 usage error (or --check had nothing to check). --check and --uninstall ask for no tool, whatever the
--tier; install and --update ask for the tools of the chosen tier.
EOF
}

# At most one mode flag per run.
set_mode() {
  if [ "$MODE" != install ]; then
    echo "Choose one of --check, --update, --uninstall" >&2
    usage >&2
    exit 2
  fi
  MODE="$1"
}

# Repeated --only or --skip flags accumulate. An empty value is a usage error.
add_target_list() {
  local which="${1#--}"
  local value="$2"
  if [ -z "$value" ]; then
    echo "Missing value for --$which" >&2
    usage >&2
    exit 2
  fi
  case "$value" in
    *$'\n'* | *$'\t'*)
      echo "Invalid value for --$which: it contains a newline or a tab" >&2
      usage >&2
      exit 2
      ;;
  esac
  if [ "$which" = only ]; then
    ONLY="${ONLY:+$ONLY,}$value"
  else
    SKIP="${SKIP:+$SKIP,}$value"
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      ;;
    --copy)
      COPY_MODE=true
      ;;
    --check)
      set_mode check
      ;;
    --update)
      set_mode update
      ;;
    --uninstall)
      set_mode uninstall
      ;;
    --tier)
      if [ $# -lt 2 ]; then
        echo "Invalid tier: (no value after --tier)" >&2
        usage >&2
        exit 2
      fi
      TIER="$2"
      shift
      ;;
    --tier=*)
      TIER="${1#--tier=}"
      ;;
    --only | --skip)
      if [ $# -lt 2 ]; then
        echo "Missing value for $1" >&2
        usage >&2
        exit 2
      fi
      add_target_list "$1" "$2"
      shift
      ;;
    --only=* | --skip=*)
      add_target_list "${1%%=*}" "${1#*=}"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

case "$TIER" in
  minimal|standard|full) ;;
  *)
    echo "Invalid tier: $TIER" >&2
    usage >&2
    exit 2
    ;;
esac

# Every id must name a row of the target table; checked before any output.
validate_target_list() {
  local list="$1"
  local id
  local ids=()
  if [ -z "$list" ]; then
    return 0
  fi
  IFS=',' read -r -a ids <<< "$list"
  for id in "${ids[@]}"; do
    if ! is_target_id "$id"; then
      echo "Unknown target: $id" >&2
      echo "Valid targets: $(valid_target_list)" >&2
      usage >&2
      exit 2
    fi
  done
}
validate_target_list "$ONLY"
validate_target_list "$SKIP"

# Git Bash, MSYS and Cygwin make `ln -s` copy the file, or fail, unless symlinks are switched on, so a
# plain install there would report links it did not make. Copy mode says what actually happens.
case "$(uname -s 2>/dev/null || true)" in
  MINGW* | MSYS* | CYGWIN*)
    if [ "$COPY_MODE" != true ]; then
      COPY_MODE=true
      echo "[NOTE] Windows shell: symlinks are not reliable here, using --copy"
    fi
    ;;
esac

mode_install() {
  install_targets
  install_selfcheck
  install_hooks
  sprites_exit_if_failed
  finish_line "==> Vivera farm planted: the Ultimate AI Coding Skill installation is complete!"
}

# The banner follows the mode; check and uninstall have no source or tier to announce.
case "$MODE" in
  install)
    echo "==> Sowing Vivera: configuring the Ultimate All-in-One AI Coding Agent Skill..."
    echo "    Source: $MASTER_FILE"
    echo "    Tier: $TIER"
    ;;
  check)
    echo "==> Checking the Vivera install"
    ;;
  update)
    echo "==> Updating Vivera"
    echo "    Source: $MASTER_FILE"
    echo "    Tier: $TIER"
    ;;
  uninstall)
    echo "==> Removing the Vivera install"
    ;;
esac

# Prerequisites check. Which tools are hard requirements depends on --tier and
#    lives in scripts/install/tiers.tsv (standard: git and bun). Every other tool
#    is optional: a missing one costs one capability, so install.sh warns (naming
#    what is lost) and continues. It runs before every mode.
# --check and --uninstall read and remove links and need neither bun nor git, so they ask for the
# minimal tier whatever --tier says; install and update keep the tier they were given.
PREREQ_TIER="$TIER"
case "$MODE" in
  check | uninstall) PREREQ_TIER=minimal ;;
esac
check_tier_prereqs "$PREREQ_TIER" "$REPO_DIR/scripts/install/tiers.tsv"
if [ "$COPY_MODE" = true ]; then
  require_copy_tools
fi

case "$MODE" in
  install) mode_install ;;
  check) mode_check ;;
  update) mode_update ;;
  uninstall) mode_uninstall ;;
esac
