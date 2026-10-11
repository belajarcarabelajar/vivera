# shellcheck shell=bash
# Sourced by install.sh: --check mode, a read-only report of every link the selected targets should have.
#
# One line per path: [ok], [missing], [stale], [dangling] or [foreign]; then `check: CURRENT` (exit 0)
# or `check: N problem(s)` (exit 1). A phase-skill dir this checkout no longer has is reported as
# [stale] too (--update prunes it). When nothing was checked at all (no selected target has skills) the
# answer is `check: nothing to check` and exit 2, never CURRENT. Nothing is created, moved or removed,
# and --dry-run changes nothing here. With --copy the copies are compared by content instead of the
# links by target. Sprite agents are not checked yet.

mode_check() {
  local selected id desired dest state target expected stale
  local problems=0
  local checked=0

  selected="$(select_targets)"
  for id in $selected; do
    if [ "$(target_kind "$id")" = none ]; then
      echo "[skip] $id: no skills target"
      continue
    fi
    # fd 3 keeps the entry list apart from stdin of the commands run in the loop.
    while IFS=$'\t' read -r -u 3 desired dest; do
      checked=$((checked + 1))
      state="$(classify_dest "$dest" "$desired")"
      case "$state" in
        inrepo)
          # The destination is a file of this checkout itself (a harness dir symlinked into the repo).
          if [ "$dest" -ef "$desired" ]; then
            echo "[ok] $dest (inside this checkout)"
          else
            echo "[foreign] $dest (inside this checkout, not the expected file)"
            problems=$((problems + 1))
          fi
          ;;
        viadir)
          # A real file of another tree, reached through a symlinked directory: not ours, left alone.
          echo "[foreign] $dest (behind a symlinked directory; left alone)"
          problems=$((problems + 1))
          ;;
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
          if [ -L "$dest" ]; then
            target="$(readlink "$dest")"
            expected="$desired"
            if [ "${COPY_MODE:-false}" = true ]; then
              expected="a copy of $desired"
            fi
            if [ ! -e "$dest" ]; then
              echo "[dangling] $dest -> $target (expected $expected)"
            else
              echo "[stale] $dest -> $target (expected $expected)"
            fi
          elif [ "${COPY_MODE:-false}" = true ]; then
            echo "[stale] $dest (copy differs from $desired)"
          else
            echo "[stale] $dest (a managed copy; expected a link to $desired)"
          fi
          problems=$((problems + 1))
          ;;
        foreign)
          if [ "${COPY_MODE:-false}" = true ]; then
            echo "[foreign] $dest (not a vivera copy; --update would move it aside)"
          else
            echo "[foreign] $dest (not a vivera link; --update would move it aside)"
          fi
          problems=$((problems + 1))
          ;;
      esac
    done 3< <(target_entries "$id")
    while IFS= read -r -u 4 stale; do
      if [ -n "$stale" ]; then
        echo "[stale] $stale (a skill this checkout no longer has; --update prunes it)"
        problems=$((problems + 1))
      fi
    done 4<<< "$(stale_phase_dirs "$id")"
  done

  if [ "$checked" -eq 0 ]; then
    echo "check: nothing to check (no selected target has skills)"
    exit 2
  fi
  if [ "$problems" -eq 0 ]; then
    echo "check: CURRENT"
    exit 0
  fi
  echo "check: $problems problem(s)"
  exit 1
}
