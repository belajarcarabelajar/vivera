# shellcheck shell=bash
# Sourced by install.sh: --uninstall mode. It undoes the links the installer made, with the same
# rule the installer used to place them (classify_dest in lib.sh): a link that is ok or ours-stale
# is removed and the newest backup is put back; anything else at that spot is the user's and stays.
# A copy-mode install (a managed copy: see copy_managed in lib.sh) is removed too, but only while it
# is still identical to its source; a modified copy stays and is reported as [KEEP]. This works with
# or without --copy, since what is on disk decides. The generated sprite agents of each selected
# harness are removed too (clean_sprites).

UNINSTALL_REMOVED=0
UNINSTALL_RESTORED=0
UNINSTALL_KEPT=0
# How many of the removed entries were managed copies and not links, so the summary names them right.
UNINSTALL_COPIES=0
# "|dir|" for every directory that still holds a kept copy, so its marker is not removed.
UNINSTALL_KEPT_DIRS=""

# Prints the newest "<dest>.vivera-bak-<UTC stamp>[-N]" beside <dest>, or nothing. Newest means the
# later stamp, then the larger N compared as a number: a name sort would put -10 before -2. A name is
# judged by its shape alone: a stray file the user named like a backup (a stamp in the future, say) is
# restored as if the installer had made it. Known and accepted; there is no record to tell them apart.
newest_backup() {
  local dest="$1"
  local dir candidate suffix stamp n
  local best="" best_stamp="" best_n=-1
  local pattern='^([0-9]{8}T[0-9]{6}Z)(-([0-9]+))?$'

  dir="$(dirname "$dest")"
  for candidate in "$dir"/*; do
    case "$candidate" in
      "$dest".vivera-bak-*) ;;
      *) continue ;;
    esac
    suffix="${candidate#"$dest".vivera-bak-}"
    # A name that only starts like a backup (a stray note) is not one.
    [[ "$suffix" =~ $pattern ]] || continue
    stamp="${BASH_REMATCH[1]}"
    n=$((10#${BASH_REMATCH[3]:-0}))
    if [[ "$stamp" > "$best_stamp" ]] || { [ "$stamp" = "$best_stamp" ] && [ "$n" -gt "$best_n" ]; }; then
      best="$candidate"
      best_stamp="$stamp"
      best_n="$n"
    fi
  done
  if [ -n "$best" ]; then
    echo "$best"
  fi
}

# A managed copy goes only while it is the installer's own bytes: identical to its source, or pristine
# (exactly what the installer last placed, merely outdated; see managed_state in lib.sh, which falls
# back to digests when cmp and diff are missing). A modified one is the user's work now. A directory is
# deleted only through remove_replaced in lib.sh, and only after that judgement.
uninstall_copy() {
  local desired="$1"
  local dest="$2"
  local backup

  if [ "$(managed_state "$desired" "$dest")" = "modified" ]; then
    UNINSTALL_KEPT=$((UNINSTALL_KEPT + 1))
    UNINSTALL_KEPT_DIRS="$UNINSTALL_KEPT_DIRS|$(dirname "$dest")|"
    echo "[KEEP] $dest (modified copy: it stays as it is; ./install.sh --update --copy replaces it after backing yours up)"
    return 0
  fi
  backup="$(newest_backup "$dest")"
  UNINSTALL_REMOVED=$((UNINSTALL_REMOVED + 1))
  UNINSTALL_COPIES=$((UNINSTALL_COPIES + 1))
  if [ -n "$backup" ]; then
    UNINSTALL_RESTORED=$((UNINSTALL_RESTORED + 1))
  fi
  if [ "$DRY_RUN" = true ]; then
    echo "[DRY-RUN] Would remove $dest"
    if [ -n "$backup" ]; then
      echo "[DRY-RUN] Would restore $backup"
    fi
  else
    remove_replaced "$dest"
    if marker_regular "$dest.vivera-managed"; then
      rm -f "$dest.vivera-managed"
    fi
    echo "[REMOVED] $dest"
    if [ -n "$backup" ]; then
      mv "$backup" "$dest"
      echo "[RESTORED] $dest from $backup"
    fi
  fi
}

uninstall_entry() {
  local desired="$1"
  local dest="$2"
  local state backup

  # A destination that is a file of this checkout itself (a harness dir symlinked into the repo) is
  # the source, not an install of it: it is never removed.
  if dest_in_repo "$dest"; then
    UNINSTALL_KEPT=$((UNINSTALL_KEPT + 1))
    echo "[KEEP] $dest (inside this checkout)"
    return 0
  fi
  # A real file or directory behind a symlinked directory belongs to another tree (another checkout,
  # the user's dotfiles): kept, and its directory keeps its marker.
  if [ ! -L "$dest" ] && [ -e "$dest" ] && behind_symlinked_dir "$dest"; then
    UNINSTALL_KEPT=$((UNINSTALL_KEPT + 1))
    UNINSTALL_KEPT_DIRS="$UNINSTALL_KEPT_DIRS|$(dirname "$dest")|"
    echo "[KEEP] $dest (behind a symlinked directory)"
    return 0
  fi
  if [ ! -L "$dest" ] && [ -e "$dest" ] && copy_managed "$dest"; then
    uninstall_copy "$desired" "$dest"
    return 0
  fi
  state="$(classify_dest "$dest" "$desired")"
  case "$state" in
    ok | ours-stale)
      backup="$(newest_backup "$dest")"
      UNINSTALL_REMOVED=$((UNINSTALL_REMOVED + 1))
      if [ -n "$backup" ]; then
        UNINSTALL_RESTORED=$((UNINSTALL_RESTORED + 1))
      fi
      if [ "$DRY_RUN" = true ]; then
        echo "[DRY-RUN] Would remove $dest"
        if [ -n "$backup" ]; then
          echo "[DRY-RUN] Would restore $backup"
        fi
      else
        rm -f "$dest"
        echo "[REMOVED] $dest"
        if [ -n "$backup" ]; then
          mv "$backup" "$dest"
          echo "[RESTORED] $dest from $backup"
        fi
      fi
      ;;
    foreign)
      UNINSTALL_KEPT=$((UNINSTALL_KEPT + 1))
      echo "[KEEP] $dest (not a vivera link)"
      ;;
  esac
}

# rmdir refuses a directory that still holds something, so a file the user put beside or inside a
# package survives. Stops at the package's parent skills dir: harness roots such as ~/.claude or
# ~/.gemini are never touched, and neither is the skills dir the Antigravity CLI ships itself (the
# builtin one), which an install did not create. The first argument is the target id, the second the
# package dir, and the rest are the directories the package's links were in: the package dir and one
# dir per phase skill.
uninstall_empty_dirs() {
  local id="$1"
  local package_dir="$2"
  shift 2
  local dir parent
  for dir in "$@"; do
    # Never a directory of this checkout, nor one that lives behind a symlinked directory (another
    # tree's), empty or not.
    if ! dest_in_repo "$dir/." && ! behind_symlinked_dir "$dir/."; then
      rmdir "$dir" 2>/dev/null || true
    fi
  done
  parent="$(dirname "$package_dir")"
  if [ "$id" != antigravity-builtin ] && ! dest_in_repo "$parent/." && ! behind_symlinked_dir "$parent/."; then
    rmdir "$parent" 2>/dev/null || true
  fi
}

# Removes the sprite agents the generator wrote into a harness's sprite dir. Only files that carry the
# generator's marker go (the generator decides; --clean needs --out), a file someone else wrote stays, and
# the dir itself goes only when that left it empty. Nothing above the sprite dir is touched. A missing
# dir prints nothing.
clean_sprites() {
  local id="$1"
  local dir why

  if ! sprite_target "$id" >/dev/null; then
    return 0
  fi
  dir="$(sprite_out_dir "$id")"
  if [ ! -d "$dir" ]; then
    return 0
  fi
  if why="$(sprite_left_alone_why "$dir")"; then
    echo "[SKIP] $id sprites: $dir $why; left alone"
    return 0
  fi
  # Before the dry-run branch: a dry run prints what the real run would do, and without bun that is a keep.
  if ! tool_available bun; then
    UNINSTALL_KEPT=$((UNINSTALL_KEPT + 1))
    echo "[KEEP] $dir (bun not found; remove the files that carry the line \"# Generated by scripts/gen-sprite-agents.mjs\" by hand)"
    return 0
  fi
  if [ "$DRY_RUN" = true ]; then
    echo "[DRY-RUN] Would remove the generated sprite agents from $dir"
    return 0
  fi
  if bun "$REPO_DIR/scripts/gen-sprite-agents.mjs" --clean --target "$(sprite_target "$id")" --out "$dir"; then
    rmdir "$dir" 2>/dev/null || true
  else
    echo "[FAIL] sprite agents for $id could not be removed (see above)" >&2
    SPRITES_FAILED="${SPRITES_FAILED:+$SPRITES_FAILED }$id"
  fi
}

mode_uninstall() {
  local selected id desired dest dir what
  local dirs=()

  UNINSTALL_REMOVED=0
  UNINSTALL_RESTORED=0
  UNINSTALL_KEPT=0
  UNINSTALL_COPIES=0
  UNINSTALL_KEPT_DIRS=""
  selected="$(select_targets)"
  for id in $selected; do
    if [ "$(target_kind "$id")" = none ]; then
      clean_sprites "$id"
      continue
    fi
    dirs=()
    # fd 3 keeps the entry list apart from stdin of the commands run in the loop.
    while IFS=$'\t' read -r -u 3 desired dest; do
      uninstall_entry "$desired" "$dest"
      dirs+=("$(dirname "$dest")")
    done 3< <(target_entries "$id")
    if [ "$(target_kind "$id")" = package ] && [ "$DRY_RUN" != true ]; then
      # A marker stays only in a directory that still holds a kept (modified) copy.
      for dir in "${dirs[@]}"; do
        if dest_in_repo "$dir/.vivera-managed"; then
          continue
        fi
        case "$UNINSTALL_KEPT_DIRS" in
          *"|$dir|"*) ;;
          *)
            if marker_regular "$dir/.vivera-managed"; then
              rm -f "$dir/.vivera-managed"
            fi
            ;;
        esac
      done
      uninstall_empty_dirs "$id" "$(target_skills_dir "$id")" "${dirs[@]}"
    fi
    clean_sprites "$id"
  done

  # "link(s)" stays while every removed entry was a link; a copy install is not made of links.
  what="link(s)"
  if [ "$UNINSTALL_COPIES" -gt 0 ]; then
    what="link(s) or copy/copies"
  fi
  if [ "$DRY_RUN" = true ]; then
    echo "==> Vivera uninstall dry run: $UNINSTALL_REMOVED $what would be removed, $UNINSTALL_RESTORED restored, $UNINSTALL_KEPT kept"
  else
    echo "==> Vivera uninstalled: $UNINSTALL_REMOVED $what removed, $UNINSTALL_RESTORED restored, $UNINSTALL_KEPT kept"
  fi
  if [ -n "$SPRITES_FAILED" ]; then
    echo "==> Vivera uninstall finished, but the sprite agents could not be removed for: $SPRITES_FAILED" >&2
    exit 1
  fi
}
