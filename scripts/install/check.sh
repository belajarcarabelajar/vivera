# shellcheck shell=bash
# Sourced by install.sh: --check mode, a read-only report of every link the selected targets should have.
#
# One line per path: [ok], [missing], [stale], [dangling] or [foreign]; then `check: CURRENT` (exit 0)
# or `check: N problem(s)` (exit 1). Nothing is created, moved or removed, and --dry-run changes
# nothing here. Sprite agents are not checked yet.

mode_check() {
  local selected id desired dest state target
  local problems=0

  selected="$(select_targets)"
  for id in $selected; do
    if [ "$(target_kind "$id")" = none ]; then
      echo "[skip] $id: no skills target"
      continue
    fi
    # fd 3 keeps the entry list apart from stdin of the commands run in the loop.
    while IFS=$'\t' read -r -u 3 desired dest; do
      state="$(classify_dest "$dest" "$desired")"
      case "$state" in
        absent)
          echo "[missing] $dest"
          problems=$((problems + 1))
          ;;
        ok)
          if [ -e "$dest" ]; then
            echo "[ok] $dest"
          else
            # The link is the right one, but the repo file it points to is gone.
            echo "[dangling] $dest (its source is missing)"
            problems=$((problems + 1))
          fi
          ;;
        ours-stale)
          target="$(readlink "$dest")"
          if [ ! -e "$dest" ]; then
            echo "[dangling] $dest -> $target (expected $desired)"
          else
            echo "[stale] $dest -> $target (expected $desired)"
          fi
          problems=$((problems + 1))
          ;;
        foreign)
          echo "[foreign] $dest (not a vivera link; --update would move it aside)"
          problems=$((problems + 1))
          ;;
      esac
    done 3< <(target_entries "$id")
  done

  if [ "$problems" -eq 0 ]; then
    echo "check: CURRENT"
    exit 0
  fi
  echo "check: $problems problem(s)"
  exit 1
}
