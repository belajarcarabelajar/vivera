# shellcheck shell=bash
# Sourced by install.sh: placing links and copies. Every link or copy the installer makes goes through
# place_entry, which first looks at what is already at the destination (classify_dest in lib.sh) so a
# user's own file is moved aside, never overwritten. COPY_MODE (--copy) turns each link into a copy
# marked as vivera's own with a .vivera-managed file.

# PLACE_QUIET: link_skill_package sets it so the dozen routine "Linked" lines of one package fold
# into its single summary line; backups, repoints and skips are always printed.
# PLACE_CHANGED: how many placements were not already current since it was last reset.
PLACE_QUIET=false
PLACE_CHANGED=0

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

# The link or the copy did not take after the user's file was moved aside: put that file back.
restore_backup() {
  local dest="$1"
  local backup="$2"
  remove_replaced "$dest" 2>/dev/null || true
  mv "$backup" "$dest"
  echo "[FAIL] could not place $dest; your file was put back" >&2
  exit 1
}

place_link() {
  local desired="$1"
  local dest="$2"
  local state old backup

  state="$(classify_dest "$dest" "$desired")"
  if [ "$state" != "ok" ] && [ "$state" != "inrepo" ]; then
    PLACE_CHANGED=$((PLACE_CHANGED + 1))
  fi

  case "$state" in
    inrepo)
      echo "[SKIP] $dest is inside this checkout; left alone"
      ;;
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
        if ! ln -s "$desired" "$dest"; then
          restore_backup "$dest" "$backup"
        fi
        echo "[BACKUP] $dest moved to $backup"
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
  mkdir -p "$(dirname "$dest")" || return 1
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
  if [ "$state" != "ok" ] && [ "$state" != "inrepo" ]; then
    PLACE_CHANGED=$((PLACE_CHANGED + 1))
  fi

  case "$state" in
    inrepo)
      echo "[SKIP] $dest is inside this checkout; left alone"
      ;;
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
        if ! copy_entry "$src" "$dest"; then
          restore_backup "$dest" "$backup"
        fi
        echo "[BACKUP] $dest moved to $backup"
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
# earlier copy install is removed once the link is in place. A marker path inside this checkout (a
# harness dir that is a symlink into the repo) is never written or removed.
settle_marker() {
  local marker="$1"
  if [ "$DRY_RUN" = true ] || dest_in_repo "$marker"; then
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
