# shellcheck shell=bash
# Sourced by install.sh: placing links and copies. Every link or copy the installer makes goes through
# place_entry, which first looks at what is already at the destination (classify_dest in lib.sh) so a
# user's own file is moved aside, never overwritten. COPY_MODE (--copy) turns each link into a copy
# marked as vivera's own with a .vivera-managed file.

# PLACE_QUIET: link_skill_package sets it so the dozen routine "Linked" lines of one package fold
# into its single summary line; backups, repoints and skips are always printed.
# PLACE_CHANGED: how many placements were not already current since it was last reset.
# PLACE_SKIPPED: how many entries of the current package were left alone (inside the checkout, or
# behind a symlinked directory), so the package is not reported as installed when it is not.
# LEFT_ALONE: the same count for the whole run, for the last line of install and update.
# PLACED_DESTS: the destinations that now hold the installer's own copy, for the digests in the marker.
# COPY_FAILED_STEP: "cp" or "mv", set by copy_entry, so a failed copy names the step that failed.
PLACE_QUIET=false
PLACE_CHANGED=0
PLACE_SKIPPED=0
LEFT_ALONE=0
PLACED_DESTS=()

# One "[SKIP] ... left alone" line, counted for the last line of the run.
left_alone() {
  echo "[SKIP] $1"
  LEFT_ALONE=$((LEFT_ALONE + 1))
}

# Last line of install and update when something was left alone: say so instead of "complete".
finish_if_left_alone() {
  local word="entries"
  if [ "$LEFT_ALONE" -gt 0 ]; then
    if [ "$LEFT_ALONE" -eq 1 ]; then
      word="entry"
    fi
    echo "==> Vivera finished with $LEFT_ALONE $word left alone (see the [SKIP] lines above)"
    exit 0
  fi
}

# A placement step failed for a reason of the machine (a read-only dir, a full disk): one clear line.
place_fail() {
  echo "[FAIL] could not place $1: $2 failed" >&2
  exit 1
}

# --- Markers ----------------------------------------------------------------------------------
# <dir>/.vivera-managed (or <dest>.vivera-managed for a lone file) holds "source=<repo>" and one
# "entry <name> <algo>:<digest>" line per entry the installer placed (see managed_state in lib.sh).

# A marker path is usable when nothing is there yet or a plain file is: never a FIFO (opening it
# would hang), a directory or a symlink. Anything else stops the run before any copy is made.
marker_check() {
  local marker="$1"
  if [ -e "$marker" ] || [ -L "$marker" ]; then
    if ! marker_regular "$marker"; then
      echo "[FAIL] $marker is not a regular file; move it away" >&2
      exit 1
    fi
  fi
}

# Copy mode, before anything is copied into the dir: the marker exists, so an abort half way leaves
# a managed dir (judged entry by entry) and not copies nobody claims.
marker_begin() {
  local marker="$1"
  if dest_in_repo "$marker"; then
    return 0
  fi
  marker_check "$marker"
  if [ -e "$marker" ]; then
    return 0
  fi
  # Copy mode places nothing behind a symlinked directory (classify_dest says viadir), so no marker
  # is made there either: it would land in the other tree with nothing to describe.
  if behind_symlinked_ancestor "$marker"; then
    return 0
  fi
  make_dir "$(dirname "$marker")"
  printf 'source=%s\n' "$REPO_DIR" > "$marker"
}

# Copy mode, after the placement: source plus one digest line per placed entry. Rewritten only when
# it differs. A name this run did not place keeps the line it has, while that name is still in the
# marker's directory: two targets can share one marker (one skills dir reached through a symlink), and
# the one that places nothing must not erase what the other recorded. The names it did place get fresh
# lines, and a line whose name is gone, or that is not an entry line, goes.
write_marker() {
  local marker="$1"
  shift
  local content="source=$REPO_DIR"
  local dest digest line rest name
  local dir placed=$'\n'
  if dest_in_repo "$marker"; then
    return 0
  fi
  marker_check "$marker"
  # Nothing is placed behind a symlinked directory in copy mode, so there is nothing to record, and
  # a marker that is there is the other tree's to keep as it is.
  if behind_symlinked_ancestor "$marker"; then
    return 0
  fi
  dir="$(dirname "$marker")"
  for dest in "$@"; do
    placed="$placed$(basename "$dest")"$'\n'
  done
  if marker_regular "$marker"; then
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        "entry "*" "*) ;;
        *) continue ;;
      esac
      rest="${line#entry }"
      name="${rest% *}"
      case "$name" in
        "" | */*) continue ;;
      esac
      case "$placed" in
        *$'\n'"$name"$'\n'*) continue ;;
      esac
      if [ -e "$dir/$name" ] || [ -L "$dir/$name" ]; then
        content="$content"$'\n'"$line"
      fi
    done < "$marker"
  fi
  for dest in "$@"; do
    digest="$(entry_digest "$dest")"
    if [ -n "$digest" ]; then
      content="$content"$'\n'"entry $(basename "$dest") $digest"
    fi
  done
  if marker_regular "$marker" && [ "$(cat "$marker")" = "$content" ]; then
    return 0
  fi
  make_dir "$(dirname "$marker")"
  printf '%s\n' "$content" > "$marker"
}

# Link mode: nothing is managed, so a marker left by an earlier copy install goes. Only a plain file
# is removed; a directory or anything else of that name was never ours, and neither is a marker behind a
# symlinked directory: it describes a copy in the other tree, whose digests must stay.
drop_marker() {
  local marker="$1"
  if dest_in_repo "$marker" || behind_symlinked_ancestor "$marker"; then
    return 0
  fi
  if marker_regular "$marker"; then
    rm -f "$marker"
  fi
}

# Clears what is at <dest> so a fresh link or copy can take its place. Callers use it only on what is
# the installer's own: an ours-stale dest, a managed copy that uninstall judged identical or pristine,
# a .vivera-tmp-* name of its own, and (restore_backup) what its own failed placement left. A real
# directory is removed with rm -r only in those cases.
remove_replaced() {
  local dest="$1"
  if [ -d "$dest" ] && [ ! -L "$dest" ]; then
    rm -r "$dest"
  else
    rm -f "$dest"
  fi
}

# The link or the copy did not take after the user's file was moved aside: put that file back. A copy
# passes the step that failed as $3 (COPY_FAILED_STEP); a link names none.
restore_backup() {
  local dest="$1"
  local backup="$2"
  local step="${3:+: $3 failed}"
  remove_replaced "$dest" 2>/dev/null || true
  mv "$backup" "$dest"
  echo "[FAIL] could not place $dest$step; your file was put back" >&2
  exit 1
}

place_link() {
  local desired="$1"
  local dest="$2"
  local state old backup

  state="$(classify_dest "$dest" "$desired")"
  if [ "$state" != "ok" ] && [ "$state" != "inrepo" ] && [ "$state" != "viadir" ]; then
    PLACE_CHANGED=$((PLACE_CHANGED + 1))
  fi

  case "$state" in
    inrepo)
      left_alone "$dest is inside this checkout; left alone"
      PLACE_SKIPPED=$((PLACE_SKIPPED + 1))
      ;;
    viadir)
      left_alone "$dest is reached through a symlinked directory; left alone"
      PLACE_SKIPPED=$((PLACE_SKIPPED + 1))
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
        make_dir "$(dirname "$dest")"
        ln -s "$desired" "$dest" || place_fail "$dest" ln
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
        remove_replaced "$dest" || place_fail "$dest" rm
        ln -s "$desired" "$dest" || place_fail "$dest" ln
        echo "[OK] Repointed: $dest -> $desired ($old)"
      fi
      ;;
    foreign)
      backup="$(backup_path "$dest")"
      if [ "$DRY_RUN" = true ]; then
        echo "[DRY-RUN] Would back up $dest to $backup, then link"
      else
        mv "$dest" "$backup" || place_fail "$dest" mv
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

# What a killed run left beside <dest>: only a name of exactly the shape copy_entry gives its temporary
# copy, <dest>.vivera-tmp-<digits>. It is not a backup and not the user's: it goes before the next copy
# to <dest>, and with --uninstall.
remove_stale_tmp() {
  local dest="$1"
  local candidate suffix
  for candidate in "$dest".vivera-tmp-*; do
    suffix="${candidate#"$dest".vivera-tmp-}"
    case "$suffix" in
      "" | *[!0-9]*) continue ;;
    esac
    if [ -e "$candidate" ] || [ -L "$candidate" ]; then
      remove_replaced "$candidate" 2>/dev/null || true
    fi
  done
}

# cp for a file, cp -RL for a directory: a copy never holds a link into the repo. The copy is made under
# a temporary name beside <dest> and renamed into place only when cp succeeded, so a run killed half way
# leaves a temporary name and never a partial copy at <dest> (which the next run would back up as the
# newest backup, and --uninstall would restore over the live path).
copy_entry() {
  local src="$1"
  local dest="$2"
  local tmp="$dest.vivera-tmp-$$"
  local copied=true
  COPY_FAILED_STEP="cp"
  make_dir "$(dirname "$dest")"
  remove_stale_tmp "$dest"
  if [ -d "$src" ]; then
    cp -RL "$src" "$tmp" || copied=false
  else
    cp "$src" "$tmp" || copied=false
  fi
  if [ "$copied" = true ]; then
    # cp keeps the source's modes: a read-only checkout would give a copy that refresh and uninstall
    # cannot remove. The digests only look at the owner exec bit, so they do not change.
    chmod -R u+w "$tmp" 2>/dev/null || true
    if mv "$tmp" "$dest"; then
      return 0
    fi
    COPY_FAILED_STEP="mv"
  fi
  remove_replaced "$tmp" 2>/dev/null || true
  return 1
}

# The copy-mode twin of place_link. A managed copy the user edited is "foreign" here (see classify_dest)
# and is moved aside like any user file; one that is merely outdated is refreshed. The marker is written
# by the caller, from PLACED_DESTS, once the whole package is placed.
place_copy() {
  local src="$1"
  local dest="$2"
  local state backup

  state="$(classify_dest "$dest" "$src")"
  if [ "$state" != "ok" ] && [ "$state" != "inrepo" ] && [ "$state" != "viadir" ]; then
    PLACE_CHANGED=$((PLACE_CHANGED + 1))
  fi

  case "$state" in
    inrepo)
      left_alone "$dest is inside this checkout; left alone"
      PLACE_SKIPPED=$((PLACE_SKIPPED + 1))
      ;;
    viadir)
      left_alone "$dest is reached through a symlinked directory; left alone"
      PLACE_SKIPPED=$((PLACE_SKIPPED + 1))
      ;;
    ok)
      PLACED_DESTS+=("$dest")
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
        copy_entry "$src" "$dest" || place_fail "$dest" "$COPY_FAILED_STEP"
        PLACED_DESTS+=("$dest")
        if [ "$PLACE_QUIET" != true ]; then
          echo "[OK] Copied: $dest"
        fi
      fi
      ;;
    ours-stale)
      if [ "$DRY_RUN" = true ]; then
        echo "[DRY-RUN] Would refresh: $dest from $src"
      else
        remove_replaced "$dest" || place_fail "$dest" rm
        copy_entry "$src" "$dest" || place_fail "$dest" "$COPY_FAILED_STEP"
        PLACED_DESTS+=("$dest")
        echo "[OK] Refreshed: $dest"
      fi
      ;;
    foreign)
      backup="$(backup_path "$dest")"
      if [ "$DRY_RUN" = true ]; then
        echo "[DRY-RUN] Would back up $dest to $backup, then copy"
      else
        mv "$dest" "$backup" || place_fail "$dest" mv
        if ! copy_entry "$src" "$dest"; then
          restore_backup "$dest" "$backup" "$COPY_FAILED_STEP"
        fi
        PLACED_DESTS+=("$dest")
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

link_target() {
  local target_dir="$1"
  local target_file="$2"
  local sidecar="$target_file.vivera-managed"

  if [ "$DRY_RUN" = true ]; then
    if [ ! -d "$target_dir" ]; then
      echo "[DRY-RUN] Would create directory: $target_dir"
    fi
    place_entry "$MASTER_FILE" "$target_file"
    return 0
  fi
  if [ "${COPY_MODE:-false}" = true ]; then
    marker_begin "$sidecar"
    PLACED_DESTS=()
    place_entry "$MASTER_FILE" "$target_file"
    write_marker "$sidecar" ${PLACED_DESTS[@]+"${PLACED_DESTS[@]}"}
  else
    place_entry "$MASTER_FILE" "$target_file"
    drop_marker "$sidecar"
  fi
}

link_skill_package() {
  local target_skill_dir="$1"
  local sibling_dir desired dest marked_dir word
  local total=0
  local placed=()
  local dirs=()
  local unique=$'\n'
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

  # The dirs the entries live in: the package dir and one dir per phase skill.
  while IFS=$'\t' read -r -u 3 desired dest; do
    total=$((total + 1))
    marked_dir="$(dirname "$dest")"
    case "$unique" in
      *$'\n'"$marked_dir"$'\n'*) ;;
      *)
        unique="$unique$marked_dir"$'\n'
        dirs+=("$marked_dir")
        ;;
    esac
  done 3<<< "$(package_entries "$target_skill_dir")"

  if [ "$DRY_RUN" != true ] && [ "${COPY_MODE:-false}" = true ]; then
    # Markers first, all of them, so a path that cannot hold one stops the run before any copy is made.
    for marked_dir in ${dirs[@]+"${dirs[@]}"}; do
      marker_begin "$marked_dir/.vivera-managed"
    done
  fi

  PLACE_QUIET=true
  PLACE_CHANGED=0
  PLACE_SKIPPED=0
  PLACED_DESTS=()
  # fd 3 keeps the entry list apart from stdin of the commands run in the loop.
  while IFS=$'\t' read -r -u 3 desired dest; do
    place_entry "$desired" "$dest"
  done 3<<< "$(package_entries "$target_skill_dir")"
  PLACE_QUIET=false

  if [ "$DRY_RUN" != true ]; then
    for marked_dir in ${dirs[@]+"${dirs[@]}"}; do
      if [ "${COPY_MODE:-false}" = true ]; then
        # The digests of what was placed here, now that it is placed.
        placed=()
        for dest in ${PLACED_DESTS[@]+"${PLACED_DESTS[@]}"}; do
          if [ "$(dirname "$dest")" = "$marked_dir" ]; then
            placed+=("$dest")
          fi
        done
        write_marker "$marked_dir/.vivera-managed" ${placed[@]+"${placed[@]}"}
      else
        drop_marker "$marked_dir/.vivera-managed"
      fi
    done
    if [ "$PLACE_SKIPPED" -gt 0 ]; then
      word="entries"
      if [ "$PLACE_SKIPPED" -eq 1 ]; then
        word="entry"
      fi
      if [ "$PLACE_SKIPPED" -ge "$total" ]; then
        echo "[WARN] skill package in: $target_skill_dir: every entry was left alone, nothing was placed"
      else
        echo "[WARN] skill package in: $target_skill_dir: $PLACE_SKIPPED $word left alone, the rest is in place"
      fi
    elif [ "$PLACE_CHANGED" -eq 0 ]; then
      echo "[OK] Already current: skill package in: $target_skill_dir"
    elif [ "${COPY_MODE:-false}" = true ]; then
      echo "[OK] Copied skill package in: $target_skill_dir"
    else
      echo "[OK] Linked skill package in: $target_skill_dir"
    fi
  fi
}
