# shellcheck shell=bash
# scripts/install/prereq.sh - tier-aware prerequisite checks. Sourced by install.sh, never run alone.
#
# The tool list is scripts/install/tiers.tsv (TAB separated: tool, required_from, capability lost).
# A tool is REQUIRED when the chosen tier ranks at or above its required_from, which makes a missing
# one a hard failure; every other tool is OPTIONAL and warns once with the capability lost.
# scripts/lib/prereq.mjs reads the same table with the same rule, and a test compares the two.
#
# Needs from the caller: check_prereq and check_optional (defined in install.sh before the call).

rank_of_tier() {
  case "$1" in
    minimal) echo 0 ;;
    standard) echo 1 ;;
    full) echo 2 ;;
    *) return 1 ;;
  esac
}

# `never` ranks above every tier, so no tier requires that tool.
rank_of_from() {
  case "$1" in
    standard) echo 1 ;;
    full) echo 2 ;;
    never) echo 99 ;;
    *) return 1 ;;
  esac
}

check_tier_prereqs() {
  local tier="$1"
  local table="$2"
  local tool from loss hint have need

  have="$(rank_of_tier "$tier")" || {
    echo "❌ Unknown tier: $tier" >&2
    exit 1
  }
  if [ ! -r "$table" ]; then
    echo "❌ Missing tier table: $table" >&2
    exit 1
  fi

  # The table is read on fd 3 so a tool that reads stdin cannot swallow the next row.
  while IFS=$'\t' read -r -u 3 tool from loss || [ -n "$tool" ]; do
    case "$tool" in
      '' | '#'*) continue ;;
    esac
    need="$(rank_of_from "$from")" || {
      echo "❌ $table: unknown required_from '$from' for '$tool'" >&2
      exit 1
    }
    if [ "$have" -ge "$need" ]; then
      hint=""
      if [ "$tool" = "bun" ]; then
        hint="curl -fsSL https://bun.sh/install | bash"
      fi
      check_prereq "$tool" "$loss" "$hint"
    else
      check_optional "$tool" "$loss"
    fi
  done 3< "$table"
}
