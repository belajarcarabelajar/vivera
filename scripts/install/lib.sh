# shellcheck shell=bash
# Sourced by install.sh: tool probing, and how a destination is judged (classify_dest) and named.
# Placing links and copies is in place.sh.

tool_available() {
  # Single source of truth for "can we call $cmd". Beyond the current PATH it
  # probes the two standard fallback dirs and, when found there, prepends that
  # dir to PATH so every later `$cmd` invocation works. Optional-tool warnings
  # fire only when all three probes fail.
  local cmd="$1"
  if command -v "$cmd" &>/dev/null; then
    return 0
  fi
  if [ -x "$HOME/.local/bin/$cmd" ]; then
    export PATH="$HOME/.local/bin:$PATH"
    return 0
  fi
  if [ -x "$HOME/.bun/bin/$cmd" ]; then
    export PATH="$HOME/.bun/bin:$PATH"
    return 0
  fi
  return 1
}

# A required tool: found, then asked for its version on a closed stdin. A tool that fails or prints
# nothing on --version still counts as found, so a failure cannot abort the run under pipefail.
check_prereq() {
  local cmd="$1"
  local label="$2"
  local min_hint="${3:-}"

  if ! tool_available "$cmd"; then
    echo "❌ Missing prerequisite: '$cmd' ($label) is mandatory." >&2
    [ -n "$min_hint" ] && echo "   Hint: $min_hint" >&2
    echo "   Install to ~/.local/bin/$cmd, ~/.bun/bin/$cmd, or system PATH." >&2
    exit 1
  fi
  local version
  version="$("$cmd" --version </dev/null 2>&1 | head -n 1 || true)"
  [ -z "$version" ] && version="installed (no version flag)"
  echo "[OK] Prerequisite verified: $cmd — $version"
}

# Optional tool: warn once with the lost capability named, then move on. A tool that is present is
# only reported as found: it is never run, because an optional tool owes this installer nothing.
check_optional() {
  local cmd="$1"
  local loss="$2"

  if ! tool_available "$cmd"; then
    echo "⚠️  WARNING: optional tool '$cmd' not found; $loss" >&2
    return 0
  fi
  echo "[OK] Optional tool found: $cmd"
}

# Absolute path whose directory part is physical (symlinks resolved) and whose last component is
# left alone. No readlink -f or realpath: macOS does not ship them.
abs_path() {
  local path="$1"
  local dir
  if dir="$(cd -P "$(dirname "$path")" 2>/dev/null && pwd -P)"; then
    if [ "$dir" = "/" ]; then
      echo "/$(basename "$path")"
    else
      echo "$dir/$(basename "$path")"
    fi
  else
    echo "$path"
  fi
}

# Copy mode compares content with cmp (files) and diff (directories).
copy_tools_present() {
  command -v cmp >/dev/null 2>&1 && command -v diff >/dev/null 2>&1
}

require_copy_tools() {
  local tool
  for tool in cmp diff; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      echo "❌ Missing prerequisite: '$tool' (copy mode compares file content) is mandatory." >&2
      exit 1
    fi
  done
}

# True when <dest> is a copy the installer made: its directory holds a .vivera-managed marker (a
# package entry) or it has a <dest>.vivera-managed sidecar (a lone file such as the ai-config one).
copy_managed() {
  local dest="$1"
  [ -f "$(dirname "$dest")/.vivera-managed" ] || [ -f "$dest.vivera-managed" ]
}

# True when the copy at <dest> has the same content as <src>: cmp for a file, diff -rq for a directory.
content_equal() {
  local src="$1"
  local dest="$2"
  copy_tools_present || return 1
  if [ -d "$src" ]; then
    [ -d "$dest" ] && [ ! -L "$dest" ] && diff -rq "$src" "$dest" >/dev/null 2>&1
  else
    [ -f "$dest" ] && [ ! -L "$dest" ] && cmp -s "$src" "$dest"
  fi
}

# True when <dest> is a file of this checkout itself: its directory, with every symlink resolved, is
# the repo or lies under it. That happens when a harness dir is a symlink into the repo (for example
# ~/.claude/skills/sucp-rules -> <repo>/skills/sucp-rules), and then the "destination" is the source.
# A directory that does not exist is not inside anything.
dest_in_repo() {
  local dest="$1"
  local dir repo_phys
  dir="$(cd -P "$(dirname "$dest")" 2>/dev/null && pwd -P)" || return 1
  repo_phys="$(cd -P "$REPO_DIR" && pwd -P)"
  case "$dir" in
    "$repo_phys" | "$repo_phys"/*) return 0 ;;
  esac
  return 1
}

# The state of a symlink at <dest>: ok when it already resolves to <desired>; ours-stale when it
# resolves inside this repo (live or dangling) or is a legacy link of the old ai-skills repo (the
# installer made it, so it is replaced without a backup); foreign for any other link, including one
# that dangles somewhere else (an unmounted drive): that is moved aside, never silently replaced.
classify_link() {
  local dest="$1"
  local desired="$2"
  local target resolved abs_desired repo_phys

  target="$(readlink "$dest")"
  case "$target" in
    /*) resolved="$target" ;;
    *) resolved="$(dirname "$dest")/$target" ;;
  esac
  resolved="$(abs_path "$resolved")"
  abs_desired="$(abs_path "$desired")"
  if [ "$target" = "$desired" ] || [ "$resolved" = "$abs_desired" ]; then
    echo "ok"
    return 0
  fi
  repo_phys="$(cd -P "$REPO_DIR" && pwd -P)"
  case "$resolved" in
    "$REPO_DIR"/* | "$repo_phys"/*)
      echo "ours-stale"
      return 0
      ;;
  esac
  # The items the old ai-skills repo linked, and nothing else under that name.
  case "$target" in
    */ai-skills/"Super Ultra Code Plan Implementation.md" | */ai-skills/skills/* | */ai-skills/templates | */ai-skills/examples | */ai-skills/mermaid.config.json | */ai-skills/mermaid.dark.config.json)
      echo "ours-stale"
      return 0
      ;;
  esac
  case "$resolved" in
    */ai-skills/"Super Ultra Code Plan Implementation.md" | */ai-skills/skills/* | */ai-skills/templates | */ai-skills/examples | */ai-skills/mermaid.config.json | */ai-skills/mermaid.dark.config.json)
      echo "ours-stale"
      return 0
      ;;
  esac
  echo "foreign"
}

# Prints exactly one of: absent, ok, ours-stale, foreign, inrepo.
#   inrepo     <dest> is a file of this checkout itself (see dest_in_repo); it is never touched
#   ok         what is wanted is there: a link to <desired>, or in copy mode a managed copy with the
#              same content as <desired>
#   ours-stale the installer's own and wrong: a link as classify_link says, or in copy mode a managed
#              copy that differs, or in link mode a managed copy that is still identical to its
#              source; replaced without a backup because nothing the user wrote is lost
#   foreign    a real file or directory without a marker, a live link anywhere else, or in link mode a
#              managed copy that differs from its source (the user may have edited it, and without
#              cmp and diff a copy cannot be judged identical): moved aside, never discarded
classify_dest() {
  local dest="$1"
  local desired="$2"
  local state

  if dest_in_repo "$dest"; then
    echo "inrepo"
  elif [ -L "$dest" ]; then
    state="$(classify_link "$dest" "$desired")"
    if [ "$state" = "ok" ] && [ "${COPY_MODE:-false}" = true ]; then
      state="ours-stale"
    fi
    echo "$state"
  elif [ -e "$dest" ]; then
    if ! copy_managed "$dest"; then
      echo "foreign"
    elif content_equal "$desired" "$dest"; then
      if [ "${COPY_MODE:-false}" = true ]; then echo "ok"; else echo "ours-stale"; fi
    elif [ "${COPY_MODE:-false}" = true ]; then
      echo "ours-stale"
    else
      echo "foreign"
    fi
  else
    echo "absent"
  fi
}

# <dest>.vivera-bak-<UTC stamp>, with -1, -2, ... appended until the name is free.
backup_path() {
  local dest="$1"
  local stamp="${VIVERA_NOW:-$(date -u +%Y%m%dT%H%M%SZ)}"
  local candidate="$dest.vivera-bak-$stamp"
  local n=1
  while [ -e "$candidate" ] || [ -L "$candidate" ]; do
    candidate="$dest.vivera-bak-$stamp-$n"
    n=$((n + 1))
  done
  echo "$candidate"
}

# The links one skill package makes in <skills dir>, one "<desired><TAB><dest>" line each, in the
# order they are placed. This is the only place that knows the list: install, check, update and
# uninstall all read it. Paths contain spaces but never a TAB or a newline.
package_entries() {
  local dir="$1"
  local sibling_dir phase_dir phase_name
  sibling_dir="$(dirname "$dir")"

  printf '%s\t%s\n' "$MASTER_FILE" "$dir/SKILL.md"
  # Phase skills are siblings of the orchestrator, so each harness discovers
  # them by name and the orchestrator can load them with the skill tool.
  for phase_dir in "$REPO_DIR"/skills/sucp-*; do
    phase_name="$(basename "$phase_dir")"
    printf '%s\t%s\n' "$phase_dir/SKILL.md" "$sibling_dir/$phase_name/SKILL.md"
  done
  printf '%s\t%s\n' "$REPO_DIR/templates" "$dir/templates"
  printf '%s\t%s\n' "$REPO_DIR/examples" "$dir/examples"
  # Theming config ships with the skill so an installed harness can reproduce
  # the same diagram rendering (font embedding, palette, dark variant).
  printf '%s\t%s\n' "$REPO_DIR/mermaid.config.json" "$dir/mermaid.config.json"
  printf '%s\t%s\n' "$REPO_DIR/mermaid.dark.config.json" "$dir/mermaid.dark.config.json"
}
