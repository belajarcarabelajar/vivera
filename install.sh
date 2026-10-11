#!/usr/bin/env bash
# install.sh - Plant the Vivera skill farm: symlink the Ultimate All-in-One AI Coding Agent Skill into every harness
# This file parses arguments and dispatches; the work lives in scripts/install/*.sh (sourced below).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MASTER_FILE="$REPO_DIR/Super Ultra Code Plan Implementation.md"
DRY_RUN=false
TIER=standard
MODE=install

usage() {
  cat <<'EOF'
Usage: ./install.sh [--tier minimal|standard|full] [--dry-run] [-h]
  --tier T    prerequisite level, default standard. The tool table is scripts/install/tiers.tsv.
                minimal   requires no tool; links the skills only (no sprite agents, no git hooks)
                standard  requires git and bun
                full      also requires gh and tgrep
  --dry-run   print what would be done and write nothing
  -h, --help  print this text
Links the master skill into ~/.config/ai, ~/.agents/skills, ~/.gemini, and
~/.config/opencode/skills, plus ~/.claude only when that harness is installed.
A tool the chosen tier does not require prints one warning naming what is lost and is skipped.
TinyFish web-evidence rules ship inside the master skill; no extra skill is deployed.
Exit codes: 0 success, 1 failure (a required tool is missing), 2 usage error.
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

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
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

# shellcheck source=scripts/install/lib.sh
. "$REPO_DIR/scripts/install/lib.sh"
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

mode_install() {
  install_targets
  install_selfcheck
  install_hooks
  echo "==> Vivera farm planted: the Ultimate AI Coding Skill installation is complete!"
}

echo "==> Sowing Vivera: configuring the Ultimate All-in-One AI Coding Agent Skill..."
echo "    Source: $MASTER_FILE"
echo "    Tier: $TIER"

# 0. Prerequisites Check. Which tools are hard requirements depends on --tier and
#    lives in scripts/install/tiers.tsv (standard: git and bun). Every other tool
#    is optional: a missing one costs one capability, so install.sh warns (naming
#    what is lost) and continues. It runs before every mode.
check_tier_prereqs "$TIER" "$REPO_DIR/scripts/install/tiers.tsv"

case "$MODE" in
  install) mode_install ;;
  check) mode_check ;;
  update) mode_update ;;
  uninstall) mode_uninstall ;;
esac
