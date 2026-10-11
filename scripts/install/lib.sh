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

# --- Link placement -------------------------------------------------------------------------
# Every link the installer makes goes through place_link, which first looks at what is already at
# the destination (classify_dest) so a user's own file is moved aside, never overwritten.

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

# Prints exactly one of: absent, ok, ours-stale, foreign.
#   ok         a symlink that already resolves to <desired>
#   ours-stale a symlink that dangles, points inside this repo, or runs through the old
#              /ai-skills repo name; the installer made it, so it is replaced without a backup
#   foreign    a real file or directory, or a live symlink anywhere else; it is the user's
classify_dest() {
  local dest="$1"
  local desired="$2"
  local target resolved abs_desired repo_phys

  if [ -L "$dest" ]; then
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
  elif [ -e "$dest" ]; then
    echo "foreign"
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
      old="$(readlink "$dest")"
      if [ "$DRY_RUN" = true ]; then
        echo "[DRY-RUN] Would repoint: $dest -> $desired (was $old)"
      else
        rm -f "$dest"
        ln -s "$desired" "$dest"
        echo "[OK] Repointed: $dest -> $desired (was $old)"
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

link_target() {
  local target_dir="$1"
  local target_file="$2"

  if [ "$DRY_RUN" = true ]; then
    echo "[DRY-RUN] Would create directory: $target_dir"
  fi
  place_link "$MASTER_FILE" "$target_file"
}

link_skill_package() {
  local target_skill_dir="$1"
  local sibling_dir
  sibling_dir="$(dirname "$target_skill_dir")"

  if [ "$DRY_RUN" = true ]; then
    echo "[DRY-RUN] Would configure skill package in: $target_skill_dir"
    echo "[DRY-RUN]   - SKILL.md -> $MASTER_FILE"
    echo "[DRY-RUN]   - templates -> $REPO_DIR/templates"
    echo "[DRY-RUN]   - examples -> $REPO_DIR/examples"
    echo "[DRY-RUN]   - mermaid.config.json -> $REPO_DIR/mermaid.config.json"
    echo "[DRY-RUN]   - mermaid.dark.config.json -> $REPO_DIR/mermaid.dark.config.json"
    echo "[DRY-RUN]   - phase skills -> $sibling_dir/sucp-*/SKILL.md"
  fi

  PLACE_QUIET=true
  PLACE_CHANGED=0
  place_link "$MASTER_FILE" "$target_skill_dir/SKILL.md"
  # Phase skills are siblings of the orchestrator, so each harness discovers
  # them by name and the orchestrator can load them with the skill tool.
  for phase_dir in "$REPO_DIR"/skills/sucp-*; do
    phase_name="$(basename "$phase_dir")"
    place_link "$phase_dir/SKILL.md" "$sibling_dir/$phase_name/SKILL.md"
  done
  place_link "$REPO_DIR/templates" "$target_skill_dir/templates"
  place_link "$REPO_DIR/examples" "$target_skill_dir/examples"
  # Theming config ships with the skill so an installed harness can reproduce
  # the same diagram rendering (font embedding, palette, dark variant).
  place_link "$REPO_DIR/mermaid.config.json" "$target_skill_dir/mermaid.config.json"
  place_link "$REPO_DIR/mermaid.dark.config.json" "$target_skill_dir/mermaid.dark.config.json"
  PLACE_QUIET=false

  if [ "$DRY_RUN" != true ]; then
    if [ "$PLACE_CHANGED" -eq 0 ]; then
      echo "[OK] Already current: skill package in: $target_skill_dir"
    else
      echo "[OK] Linked skill package in: $target_skill_dir"
    fi
  fi
}
