# shellcheck shell=bash
# Sourced by install.sh: --check mode, a read-only report of every link the selected targets should have.
#
# One line per path: [ok], [missing], [stale], [dangling] or [foreign]; then `check: CURRENT` (exit 0)
# or `check: N problem(s)` (exit 1). A phase-skill dir this checkout no longer has is reported as
# [stale] too (--update prunes it). When nothing was checked at all (no selected target has skills) the
# answer is `check: nothing to check` and exit 2, never CURRENT. Nothing is created, moved or removed,
# and --dry-run changes nothing here. With --copy the copies are compared by content instead of the
# links by target. A harness with sprite agents also gets one line for its sprite dir, from the
# generator's own --check: [ok]; [missing] when every file it would render is absent (dir empty, partly
# filled or holding only the user's files); [stale] when a generated file differs or its sprite left the
# crew; [FAIL] with the generator's first error line when it fails for another reason (a refused
# hand-written file, a corrupt crew.json), since --update could not fix that. A sprite check that is
# skipped (no bun, tier minimal, a dir inside this checkout or behind a symlinked directory) is a [skip]
# line and counts for nothing; the last line then says "sprite agents not verified: <why>" instead of a
# bare CURRENT.

# The counters live in globals so check_sprites can add to them. CHECK_UNVERIFIED lists, separated by
# "; ", why some sprite check was skipped.
CHECK_PROBLEMS=0
CHECK_CHECKED=0
CHECK_UNVERIFIED=""

# Remembers one reason a sprite check was skipped, once.
sprite_unverified() {
  case "; $CHECK_UNVERIFIED;" in
    *"; $1;"*) ;;
    *) CHECK_UNVERIFIED="${CHECK_UNVERIFIED:+$CHECK_UNVERIFIED; }$1" ;;
  esac
}

# Runs the generator's --check for one harness and prints one line. Its stderr says which it is: a
# refusal line ("... left untouched") or an error that does not end in the "out of date" line is not
# drift, so [FAIL] with that first line; otherwise each drift line ends in ": missing" (no such file) or
# in another reason (the file exists and differs), and one existing file is enough for [stale].
check_sprite_dir() {
  local id="$1"
  local dir="$2"
  local errors line first="" refused="" last="" present=0
  local code=0

  set_sprite_args "$id"
  errors="$(bun "$REPO_DIR/scripts/gen-sprite-agents.mjs" "${SPRITE_ARGS[@]}" --check 2>&1 >/dev/null)" || code=$?
  if [ "$code" -eq 0 ]; then
    echo "[ok] $dir (sprite agents)"
    return 0
  fi
  while IFS= read -r line; do
    if [ -z "$line" ]; then
      continue
    fi
    if [ -z "$first" ]; then
      first="$line"
    fi
    last="$line"
    case "$line" in
      *"left untouched") refused="${refused:-$line}" ;;
      "sprite agents are out of date:"*) ;;
      *": missing") ;;
      *) present=$((present + 1)) ;;
    esac
  done <<< "$errors"
  CHECK_PROBLEMS=$((CHECK_PROBLEMS + 1))
  if [ -n "$refused" ]; then
    echo "[FAIL] $id sprites: $refused"
  elif [ "${last#sprite agents are out of date:}" = "$last" ]; then
    echo "[FAIL] $id sprites: ${first:-the generator exited $code without a message}"
  elif [ "$present" -eq 0 ]; then
    echo "[missing] $dir (sprite agents)"
  else
    echo "[stale] $dir (sprite agents are out of date or hand-edited; --update renders them again)"
  fi
}

# One line for a harness's sprite dir. The generator runs with --check, which writes nothing.
check_sprites() {
  local id="$1"
  local dir why

  if ! sprite_target "$id" >/dev/null; then
    return 0
  fi
  dir="$(sprite_out_dir "$id")"
  if [ "$TIER" = minimal ]; then
    echo "[skip] $id sprites: tier minimal renders none"
    sprite_unverified "tier minimal renders none"
  elif why="$(sprite_left_alone_why "$dir")"; then
    echo "[skip] $id sprites: $dir $why; left alone"
    sprite_unverified "a sprite dir $why"
  elif ! tool_available bun; then
    echo "[skip] $id sprites: bun not found"
    sprite_unverified "bun is missing"
  elif [ ! -d "$dir" ]; then
    echo "[missing] $dir (sprite agents)"
    CHECK_CHECKED=$((CHECK_CHECKED + 1))
    CHECK_PROBLEMS=$((CHECK_PROBLEMS + 1))
  else
    CHECK_CHECKED=$((CHECK_CHECKED + 1))
    check_sprite_dir "$id" "$dir"
  fi
}

mode_check() {
  local selected id desired dest state target expected stale note
  CHECK_PROBLEMS=0
  CHECK_CHECKED=0
  CHECK_UNVERIFIED=""

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

  note=""
  if [ -n "$CHECK_UNVERIFIED" ]; then
    note="sprite agents not verified: $CHECK_UNVERIFIED"
  fi
  if [ "$CHECK_CHECKED" -eq 0 ]; then
    echo "check: nothing to check (no selected target has skills)${note:+; $note}"
    exit 2
  fi
  if [ "$CHECK_PROBLEMS" -eq 0 ]; then
    echo "check: CURRENT${note:+ ($note)}"
    exit 0
  fi
  echo "check: $CHECK_PROBLEMS problem(s)"
  exit 1
}
