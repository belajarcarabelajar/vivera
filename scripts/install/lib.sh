# shellcheck shell=bash
# Sourced by install.sh: tool probing and the link primitives shared by every mode.

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
  version="$($cmd --version 2>&1 | head -n 1)"
  [ -z "$version" ] && version="installed (no version flag)"
  echo "[OK] Prerequisite verified: $cmd — $version"
}

# Optional tool: warn once with the lost capability named, then move on. When
# present it reports exactly like a hard prerequisite (same [OK] line).
check_optional() {
  local cmd="$1"
  local loss="$2"

  if ! tool_available "$cmd"; then
    echo "⚠️  WARNING: optional tool '$cmd' not found; $loss" >&2
    return 0
  fi
  check_prereq "$cmd" "optional tool"
}

# --- Link and copy placement ----------------------------------------------------------------
# Every link or copy the installer makes goes through place_entry, which first looks at what is
# already at the destination (classify_dest) so a user's own file is moved aside, never overwritten.
# COPY_MODE (--copy) turns each link into a copy marked as vivera's own with a .vivera-managed file.

# PLACE_QUIET: link_skill_package sets it so the dozen routine "Linked" lines of one package fold
# into its single summary line; backups and repoints are always printed.
# PLACE_CHANGED: how many placements were not already current since it was last reset.
PLACE_QUIET=false
PLACE_CHANGED=0

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

# One line marks a package dir (or a lone file, by sidecar) as vivera's own. Rewritten only when it differs.
write_marker() {
  local marker="$1"
  local line="source=$REPO_DIR"
  if [ -f "$marker" ] && [ "$(cat "$marker")" = "$line" ]; then
    return 0
  fi
  mkdir -p "$(dirname "$marker")"
  printf '%s\n' "$line" > "$marker"
}

# The state of a symlink at <dest>: ok when it already resolves to <desired>; ours-stale when it
# dangles, points inside this repo, or runs through the old /ai-skills repo name (the installer made
# it, so it is replaced without a backup); foreign for a live link anywhere else.
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
  if [ ! -e "$dest" ]; then
    echo "ours-stale"
    return 0
  fi
  repo_phys="$(cd -P "$REPO_DIR" && pwd -P)"
  case "$resolved" in
    "$REPO_DIR"/* | "$repo_phys"/*)
      echo "ours-stale"
      return 0
      ;;
  esac
  case "$target" in
    */ai-skills/* | */ai-skills)
      echo "ours-stale"
      return 0
      ;;
  esac
  case "$resolved" in
    */ai-skills/* | */ai-skills)
      echo "ours-stale"
      return 0
      ;;
  esac
  echo "foreign"
}

# Prints exactly one of: absent, ok, ours-stale, foreign.
#   ok         what is wanted is there: a link to <desired>, or in copy mode a managed copy with the
#              same content as <desired>
#   ours-stale the installer's own and wrong: a link as above, or in copy mode a managed copy that
#              differs, or in link mode a managed copy that is still identical to its source; replaced
#              without a backup because nothing the user wrote is lost
#   foreign    a real file or directory without a marker, a live link anywhere else, or in link mode a
#              managed copy that differs from its source (the user may have edited it, and without
#              cmp and diff a copy cannot be judged identical): moved aside, never discarded
classify_dest() {
  local dest="$1"
  local desired="$2"
  local state

  if [ -L "$dest" ]; then
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

# Clears what is at <dest> so a fresh link or copy can take its place. Only callers that know <dest>
# is the installer's own use it (classified ours-stale, or a managed copy verified identical to its
# source by uninstall): a managed copy directory is the one real directory removed with rm -r.
remove_replaced() {
  local dest="$1"
  if [ -d "$dest" ] && [ ! -L "$dest" ]; then
    rm -r "$dest"
  else
    rm -f "$dest"
  fi
}

place_link() {
  local desired="$1"
  local dest="$2"
  local state old backup

  state="$(classify_dest "$dest" "$desired")"
  if [ "$state" != "ok" ]; then
    PLACE_CHANGED=$((PLACE_CHANGED + 1))
  fi

  case "$state" in
    ok)
      if [ "$PLACE_QUIET" != true ]; then
        echo "[OK] Already current: $dest"
      fi
      ;;
    absent)
      if [ "$DRY_RUN" = true ]; then
        if [ "$PLACE_QUIET" != true ]; then
          echo "[DRY-RUN] Would link: $dest -> $desired"
        fi
      else
        mkdir -p "$(dirname "$dest")"
        ln -s "$desired" "$dest"
        if [ "$PLACE_QUIET" != true ]; then
          echo "[OK] Linked: $dest -> $desired"
        fi
      fi
      ;;
    ours-stale)
      if [ -L "$dest" ]; then
        old="was $(readlink "$dest")"
      else
        old="was a managed copy"
      fi
      if [ "$DRY_RUN" = true ]; then
        echo "[DRY-RUN] Would repoint: $dest -> $desired ($old)"
      else
        remove_replaced "$dest"
        ln -s "$desired" "$dest"
        echo "[OK] Repointed: $dest -> $desired ($old)"
      fi
      ;;
    foreign)
      backup="$(backup_path "$dest")"
      if [ "$DRY_RUN" = true ]; then
        echo "[DRY-RUN] Would back up $dest to $backup, then link"
      else
        mv "$dest" "$backup"
        echo "[BACKUP] $dest moved to $backup"
        ln -s "$desired" "$dest"
        if [ "$PLACE_QUIET" != true ]; then
          echo "[OK] Linked: $dest -> $desired"
        fi
      fi
      ;;
  esac
}

# cp for a file, cp -RL for a directory: a copy never holds a link into the repo.
copy_entry() {
  local src="$1"
  local dest="$2"
  mkdir -p "$(dirname "$dest")"
  if [ -d "$src" ]; then
    cp -RL "$src" "$dest"
  else
    cp "$src" "$dest"
  fi
}

# The copy-mode twin of place_link. The marker is written by the caller once the whole package is placed.
place_copy() {
  local src="$1"
  local dest="$2"
  local state backup

  state="$(classify_dest "$dest" "$src")"
  if [ "$state" != "ok" ]; then
    PLACE_CHANGED=$((PLACE_CHANGED + 1))
  fi

  case "$state" in
    ok)
      if [ "$PLACE_QUIET" != true ]; then
        echo "[OK] Already current: $dest"
      fi
      ;;
    absent)
      if [ "$DRY_RUN" = true ]; then
        if [ "$PLACE_QUIET" != true ]; then
          echo "[DRY-RUN] Would copy: $src -> $dest"
        fi
      else
        copy_entry "$src" "$dest"
        if [ "$PLACE_QUIET" != true ]; then
          echo "[OK] Copied: $dest"
        fi
      fi
      ;;
    ours-stale)
      if [ "$DRY_RUN" = true ]; then
        echo "[DRY-RUN] Would refresh: $dest from $src"
      else
        remove_replaced "$dest"
        copy_entry "$src" "$dest"
        echo "[OK] Refreshed: $dest"
      fi
      ;;
    foreign)
      backup="$(backup_path "$dest")"
      if [ "$DRY_RUN" = true ]; then
        echo "[DRY-RUN] Would back up $dest to $backup, then copy"
      else
        mv "$dest" "$backup"
        echo "[BACKUP] $dest moved to $backup"
        copy_entry "$src" "$dest"
        if [ "$PLACE_QUIET" != true ]; then
          echo "[OK] Copied: $dest"
        fi
      fi
      ;;
  esac
}

# The one dispatcher: COPY_MODE picks place_copy, otherwise place_link.
place_entry() {
  if [ "${COPY_MODE:-false}" = true ]; then
    place_copy "$1" "$2"
  else
    place_link "$1" "$2"
  fi
}

# Links inside this repo's own skills/super-ultra-code-plan use relative targets so a moved
# checkout keeps working. Nothing there is the user's, so there is no backup: skip when already
# right, otherwise replace.
place_repo_link() {
  local relative_target="$1"
  local dest="$2"

  if [ -L "$dest" ] && [ "$(readlink "$dest")" = "$relative_target" ]; then
    return 0
  fi
  rm -f "$dest"
  ln -s "$relative_target" "$dest"
}

# A lone file's marker goes beside it. In link mode nothing is managed, so a leftover marker from an
# earlier copy install is removed once the link is in place.
settle_marker() {
  local marker="$1"
  if [ "$DRY_RUN" = true ]; then
    return 0
  fi
  if [ "${COPY_MODE:-false}" = true ]; then
    write_marker "$marker"
  else
    rm -f "$marker"
  fi
}

link_target() {
  local target_dir="$1"
  local target_file="$2"

  if [ "$DRY_RUN" = true ]; then
    echo "[DRY-RUN] Would create directory: $target_dir"
  fi
  place_entry "$MASTER_FILE" "$target_file"
  settle_marker "$target_file.vivera-managed"
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

link_skill_package() {
  local target_skill_dir="$1"
  local sibling_dir desired dest marked_dir
  local dirs=()
  sibling_dir="$(dirname "$target_skill_dir")"

  if [ "$DRY_RUN" = true ]; then
    if [ "${COPY_MODE:-false}" = true ]; then
      echo "[DRY-RUN] Would copy the skill package into: $target_skill_dir"
      echo "[DRY-RUN]   - SKILL.md, templates, examples and the mermaid configs, each with a .vivera-managed marker"
      echo "[DRY-RUN]   - phase skills -> $sibling_dir/sucp-*/SKILL.md"
    else
      echo "[DRY-RUN] Would configure skill package in: $target_skill_dir"
      echo "[DRY-RUN]   - SKILL.md -> $MASTER_FILE"
      echo "[DRY-RUN]   - templates -> $REPO_DIR/templates"
      echo "[DRY-RUN]   - examples -> $REPO_DIR/examples"
      echo "[DRY-RUN]   - mermaid.config.json -> $REPO_DIR/mermaid.config.json"
      echo "[DRY-RUN]   - mermaid.dark.config.json -> $REPO_DIR/mermaid.dark.config.json"
      echo "[DRY-RUN]   - phase skills -> $sibling_dir/sucp-*/SKILL.md"
    fi
  fi

  PLACE_QUIET=true
  PLACE_CHANGED=0
  # fd 3 keeps the entry list apart from stdin of the commands run in the loop.
  while IFS=$'\t' read -r -u 3 desired dest; do
    place_entry "$desired" "$dest"
    dirs+=("$(dirname "$dest")")
  done 3<<< "$(package_entries "$target_skill_dir")"
  PLACE_QUIET=false

  if [ "$DRY_RUN" != true ]; then
    # Markers go in only now, so the placement above judged every entry before any of them was marked.
    for marked_dir in "${dirs[@]}"; do
      settle_marker "$marked_dir/.vivera-managed"
    done
    if [ "$PLACE_CHANGED" -eq 0 ]; then
      echo "[OK] Already current: skill package in: $target_skill_dir"
    elif [ "${COPY_MODE:-false}" = true ]; then
      echo "[OK] Copied skill package in: $target_skill_dir"
    else
      echo "[OK] Linked skill package in: $target_skill_dir"
    fi
  fi
}
