# shellcheck shell=bash
# Sourced by install.sh: --uninstall mode. It undoes the links the installer made, with the same
# rule the installer used to place them (classify_dest in lib.sh): a link that is ok or ours-stale
# is removed and the newest backup is put back; anything else at that spot is the user's and stays.
# Sprite agents are not handled here.

UNINSTALL_REMOVED=0
UNINSTALL_RESTORED=0
UNINSTALL_KEPT=0

# Prints the newest "<dest>.vivera-bak-<UTC stamp>[-N]" beside <dest>, or nothing. Newest means the
# later stamp, then the larger N compared as a number: a name sort would put -10 before -2.
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

uninstall_entry() {
  local desired="$1"
  local dest="$2"
  local state backup

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
# ~/.gemini are never touched. The arguments after the first are the directories the package's
# links were in: the package dir and one dir per phase skill.
uninstall_empty_dirs() {
  local package_dir="$1"
  shift
  local dir
  for dir in "$@"; do
    rmdir "$dir" 2>/dev/null || true
  done
  rmdir "$(dirname "$package_dir")" 2>/dev/null || true
}

mode_uninstall() {
  local selected id desired dest
  local dirs=()

  UNINSTALL_REMOVED=0
  UNINSTALL_RESTORED=0
  UNINSTALL_KEPT=0
  selected="$(select_targets)"
  for id in $selected; do
    if [ "$(target_kind "$id")" = none ]; then
      continue
    fi
    dirs=()
    # fd 3 keeps the entry list apart from stdin of the commands run in the loop.
    while IFS=$'\t' read -r -u 3 desired dest; do
      uninstall_entry "$desired" "$dest"
      dirs+=("$(dirname "$dest")")
    done 3< <(target_entries "$id")
    if [ "$(target_kind "$id")" = package ] && [ "$DRY_RUN" != true ]; then
      uninstall_empty_dirs "$(target_skills_dir "$id")" "${dirs[@]}"
    fi
  done

  if [ "$DRY_RUN" = true ]; then
    echo "==> Vivera uninstall dry run: $UNINSTALL_REMOVED link(s) would be removed, $UNINSTALL_RESTORED restored, $UNINSTALL_KEPT kept"
  else
    echo "==> Vivera uninstalled: $UNINSTALL_REMOVED link(s) removed, $UNINSTALL_RESTORED restored, $UNINSTALL_KEPT kept"
  fi
}
