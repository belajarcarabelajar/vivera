# shellcheck shell=bash
# scripts/install/prereq.sh - tier-aware prerequisite checks. Sourced by install.sh, never run alone.
#
# The tool list is scripts/install/tiers.tsv (TAB separated: tool, required_from, capability lost).
# A tool is REQUIRED when the chosen tier ranks at or above its required_from, which makes a missing
# one a hard failure; every other tool is OPTIONAL and warns once with the capability lost.
# scripts/lib/prereq.mjs reads the same table with the same rule, and a test compares the two.
#
# Needs from the caller: check_prereq and check_optional (defined in lib.sh).

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

# Spaces and tabs around a field, and nothing else: scripts/lib/prereq.mjs trims the same two characters.
trim_blanks() {
  local s="$1"
  local blanks=$' \t'
  s="${s#"${s%%[!$blanks]*}"}"
  s="${s%"${s##*[!$blanks]}"}"
  printf '%s' "$s"
}

# Reads the whole table into TIER_TOOLS, TIER_FROMS and TIER_LOSSES, refusing a bad row before any tool
# is looked at. ONE normalization, mirrored by parseTierTable in scripts/lib/prereq.mjs: drop a UTF-8 BOM
# at the start of a line and every CR, trim spaces and tabs from the line, skip a blank line or one whose
# first character is #, then split at the first two tabs into tool, required_from and loss (everything
# after the second tab, trimmed, and optional). A missing tool or required_from, an unknown required_from
# and a duplicate tool are refused, naming the line.
read_tier_table() {
  local table="$1"
  local line n=0 rest tool from loss
  local seen=$'\n'
  TIER_TOOLS=()
  TIER_FROMS=()
  TIER_LOSSES=()

  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    line="${line#$'\xEF\xBB\xBF'}"
    line="${line//$'\r'/}"
    line="$(trim_blanks "$line")"
    case "$line" in
      '' | '#'*) continue ;;
    esac
    case "$line" in
      *$'\t'*)
        tool="${line%%$'\t'*}"
        rest="${line#*$'\t'}"
        ;;
      *)
        tool="$line"
        rest=""
        ;;
    esac
    case "$rest" in
      *$'\t'*)
        from="${rest%%$'\t'*}"
        loss="${rest#*$'\t'}"
        ;;
      *)
        from="$rest"
        loss=""
        ;;
    esac
    tool="$(trim_blanks "$tool")"
    from="$(trim_blanks "$from")"
    loss="$(trim_blanks "$loss")"

    if [ -z "$tool" ] || [ -z "$from" ]; then
      echo "❌ $table: line $n: a row needs a tool and a required_from, separated by a tab" >&2
      exit 1
    fi
    if ! rank_of_from "$from" >/dev/null; then
      echo "❌ $table: line $n: unknown required_from '$from' for '$tool'" >&2
      exit 1
    fi
    case "$seen" in
      *$'\n'"$tool"$'\n'*)
        echo "❌ $table: line $n: duplicate tool '$tool'" >&2
        exit 1
        ;;
    esac
    seen="$seen$tool"$'\n'
    TIER_TOOLS+=("$tool")
    TIER_FROMS+=("$from")
    TIER_LOSSES+=("$loss")
  done < "$table"
}

check_tier_prereqs() {
  local tier="$1"
  local table="$2"
  local hint have need i count

  have="$(rank_of_tier "$tier")" || {
    echo "❌ Unknown tier: $tier" >&2
    exit 1
  }
  if [ ! -r "$table" ]; then
    echo "❌ Missing tier table: $table" >&2
    exit 1
  fi

  read_tier_table "$table"
  # Indexed, not "${arr[@]}": an empty array is an unbound variable under set -u on bash before 4.4.
  count="${#TIER_TOOLS[@]}"
  i=0
  while [ "$i" -lt "$count" ]; do
    need="$(rank_of_from "${TIER_FROMS[$i]}")"
    if [ "$have" -ge "$need" ]; then
      hint=""
      if [ "${TIER_TOOLS[$i]}" = "bun" ]; then
        hint="curl -fsSL https://bun.sh/install | bash   (the installer needs unzip; on Alpine it also needs libstdc++)"
      fi
      check_prereq "${TIER_TOOLS[$i]}" "${TIER_LOSSES[$i]}" "$hint"
    else
      check_optional "${TIER_TOOLS[$i]}" "${TIER_LOSSES[$i]}"
    fi
    i=$((i + 1))
  done
}
