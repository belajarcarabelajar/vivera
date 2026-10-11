# shellcheck shell=bash
# Sourced by install.sh: --check mode, a read-only report of every link the selected targets should have.
#
# One line per path: [ok], [missing], [stale], [dangling] or [foreign]; then `check: CURRENT` (exit 0)
# or `check: N problem(s)` (exit 1). A phase-skill dir this checkout no longer has is reported as
# [stale] too (--update prunes it). When nothing was checked at all (no selected target has skills) the
# answer is `check: nothing to check` and exit 2, never CURRENT. Nothing is created, moved or removed,
# and --dry-run changes nothing here. With --copy the copies are compared by content instead of the
# links by target. A harness with sprite agents also gets one line for its sprite dir, from the
# generator's own --check ([ok], [stale] or [missing]); without bun those are [skip] lines and count
# for nothing.

# The counters live in globals so check_sprites can add to them.
CHECK_PROBLEMS=0
CHECK_CHECKED=0

# One line for a harness's sprite dir. The generator runs with --check, which writes nothing.
check_sprites() {
  local id="$1"
  local dir

  if ! sprite_target "$id" >/dev/null; then
    return 0
  fi
  dir="$(sprite_out_dir "$id")"
  if [ "$TIER" = minimal ]; then
    echo "[skip] $id sprites: tier minimal renders none"
  elif sprite_dir_in_repo "$dir"; then
    echo "[skip] $id sprites: $dir is inside this checkout"
  elif ! tool_available bun; then
    echo "[skip] $id sprites: bun not found"
  elif [ ! -d "$dir" ]; then
    echo "[missing] $dir (sprite agents)"
    CHECK_CHECKED=$((CHECK_CHECKED + 1))
    CHECK_PROBLEMS=$((CHECK_PROBLEMS + 1))
  else
    CHECK_CHECKED=$((CHECK_CHECKED + 1))
    set_sprite_args "$id"
    if bun "$REPO_DIR/scripts/gen-sprite-agents.mjs" "${SPRITE_ARGS[@]}" --check >/dev/null 2>&1; then
      echo "[ok] $dir (sprite agents)"
    else
      echo "[stale] $dir (sprite agents are out of date or hand-edited; --update renders them again)"
      CHECK_PROBLEMS=$((CHECK_PROBLEMS + 1))
    fi
  fi
}

mode_check() {
  local selected id desired dest state target expected stale
  CHECK_PROBLEMS=0
  CHECK_CHECKED=0

  selected="$(select_targets)"
  for id in $selected; do
    if [ "$(target_kind "$id")" = none ]; then
      echo "[skip] $id: no skills target"
      check_sprites "$id"
      continue
    fi
    # fd 3 keeps the entry list apart from stdin of the commands run in the loop.
    while IFS=$'\t' read -r -u 3 desired dest; do
      CHECK_CHECKED=$((CHECK_CHECKED + 1))
      state="$(classify_dest "$dest" "$desired")"
      case "$state" in
        inrepo)
          # The destination is a file of this checkout itself (a harness dir symlinked into the repo).
          if [ "$dest" -ef "$desired" ]; then
            echo "[ok] $dest (inside this checkout)"
          else
            echo "[foreign] $dest (inside this checkout, not the expected file)"
            CHECK_PROBLEMS=$((CHECK_PROBLEMS + 1))
          fi
          ;;
        viadir)
          # A real file of another tree, reached through a symlinked directory: not ours, left alone.
          echo "[foreign] $dest (behind a symlinked directory; left alone)"
          CHECK_PROBLEMS=$((CHECK_PROBLEMS + 1))
          ;;
        absent)
          echo "[missing] $dest"
          CHECK_PROBLEMS=$((CHECK_PROBLEMS + 1))
          ;;
        ok)
          if [ -e "$dest" ]; then
            echo "[ok] $dest"
          else
            # The link is the right one, but the repo file it points to is gone.
            echo "[dangling] $dest (its source is missing)"
            CHECK_PROBLEMS=$((CHECK_PROBLEMS + 1))
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
          CHECK_PROBLEMS=$((CHECK_PROBLEMS + 1))
          ;;
        foreign)
          if [ ! -L "$dest" ] && [ -e "$dest" ] && copy_managed "$dest"; then
            # The installer's own copy, edited since: --update moves it aside before refreshing it.
            echo "[stale] $dest (copy edited since it was installed; --update moves it aside)"
          elif [ "${COPY_MODE:-false}" = true ]; then
            echo "[foreign] $dest (not a vivera copy; --update would move it aside)"
          else
            echo "[foreign] $dest (not a vivera link; --update would move it aside)"
          fi
          CHECK_PROBLEMS=$((CHECK_PROBLEMS + 1))
          ;;
      esac
    done 3< <(target_entries "$id")
    while IFS= read -r -u 4 stale; do
      if [ -n "$stale" ]; then
        echo "[stale] $stale (a skill this checkout no longer has; --update prunes it)"
        CHECK_PROBLEMS=$((CHECK_PROBLEMS + 1))
      fi
    done 4<<< "$(stale_phase_dirs "$id")"
    check_sprites "$id"
  done

  if [ "$CHECK_CHECKED" -eq 0 ]; then
    echo "check: nothing to check (no selected target has skills)"
    exit 2
  fi
  if [ "$CHECK_PROBLEMS" -eq 0 ]; then
    echo "check: CURRENT"
    exit 0
  fi
  echo "check: $CHECK_PROBLEMS problem(s)"
  exit 1
}
