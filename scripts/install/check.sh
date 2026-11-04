# shellcheck shell=bash
# Sourced by install.sh: --check mode, a read-only report of every link the selected targets should have.
#
# One line per path: [ok], [missing], [stale], [dangling] or [foreign]; then `check: CURRENT` (exit 0)
# or `check: N problem(s)` (exit 1). Over a copy install checked without --copy, one `[hint]` line before
# that verdict says to run --check --copy; it changes no count and no exit code. A phase-skill dir this
# checkout no longer has is reported as [stale] too (--update prunes it). When nothing was checked at
# all (no selected target has skills) the
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
#
# After the targets come two machine rows that never change a count or the exit code: `hooks-path`
# ([ok] or [warn] on core.hooksPath in a git checkout of its own, else [skip]) and `bun-version` ([ok]
# or [warn] on the installed bun against packageManager in package.json, [skip] with no bun).
# On a problem, `[draft]` lines before the verdict hold a `gh issue create` command for the user to run
# by hand; install.sh never runs it, and HOME in its body is written as ~.

# The counters live in globals so check_sprites can add to them. CHECK_UNVERIFIED lists, separated by
# "; ", why some sprite check was skipped.
CHECK_PROBLEMS=0
CHECK_CHECKED=0
CHECK_UNVERIFIED=""
# Set when a [stale] entry was a managed copy met in link mode, so the closing [hint] is printed once.
CHECK_COPIES_SEEN=false
# The problem rows printed so far, one per line, for the issue draft.
CHECK_FAILED_ROWS=""
CHECK_BUN_VERSION="not found"

# Prints one report row and remembers it when its tag is a problem.
check_row() {
  echo "$1"
  case "$1" in
    "[missing]"* | "[stale]"* | "[dangling]"* | "[foreign]"* | "[FAIL]"*)
      CHECK_FAILED_ROWS="${CHECK_FAILED_ROWS:+$CHECK_FAILED_ROWS$'\n'}$1"
      ;;
  esac
}

# The machine rows. Read-only: git config is read, JSON is parsed by bun from a path passed in the
# environment, so a path never becomes code.
# defer: no hooks-path or bun-version rows in install.ps1 -Check, upgrade when a Windows install is
# reported broken
check_machine_rows() {
  local hooks_path pinned

  if tool_available git && repo_is_own_checkout; then
    hooks_path="$(git -C "$REPO_DIR" config core.hooksPath 2>/dev/null)" || hooks_path=""
    if [ "$hooks_path" = .githooks ]; then
      echo "[ok] hooks-path: core.hooksPath is .githooks"
    else
      echo "[warn] hooks-path: core.hooksPath is ${hooks_path:-unset}, expected .githooks (./install.sh sets it)"
    fi
  else
    echo "[skip] hooks-path: $REPO_DIR is not a git checkout of its own"
  fi

  if ! tool_available bun; then
    echo "[skip] bun-version: bun not found"
    return 0
  fi
  CHECK_BUN_VERSION="$(bun --version 2>/dev/null)" || CHECK_BUN_VERSION="unknown"
  pinned="$(VIVERA_PKG="$REPO_DIR/package.json" bun -e '
    try {
      const p = JSON.parse(require("fs").readFileSync(process.env.VIVERA_PKG, "utf8")).packageManager;
      if (typeof p === "string") console.log(p);
    } catch {}' 2>/dev/null)" || pinned=""
  if [ -z "$pinned" ]; then
    echo "[warn] bun-version: bun $CHECK_BUN_VERSION is installed; no packageManager found in $REPO_DIR/package.json"
  elif [ "bun@$CHECK_BUN_VERSION" = "$pinned" ]; then
    echo "[ok] bun-version: bun $CHECK_BUN_VERSION matches packageManager $pinned"
  else
    echo "[warn] bun-version: bun $CHECK_BUN_VERSION is installed, package.json pins $pinned"
  fi
}

# Prints the issue draft for the problems found. Never runs gh: the user decides whether to file it.
check_issue_draft() {
  local id harnesses="" rows="" count=0 line body tilde='~'

  for id in $(target_ids); do
    if target_detected "$id"; then
      harnesses="${harnesses:+$harnesses }$id"
    fi
  done
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    count=$((count + 1))
    if [ "$count" -le 20 ]; then
      rows="${rows:+$rows$'\n'}$line"
    fi
  done <<< "$CHECK_FAILED_ROWS"
  if [ "$count" -gt 20 ]; then
    rows="$rows"$'\n'"... and $((count - 20)) more"
  fi
  body="install.sh --check found $CHECK_PROBLEMS problem(s)."$'\n\n'
  body+="OS: $(uname -sr 2>/dev/null || echo unknown)"$'\n'
  body+="bun: $CHECK_BUN_VERSION"$'\n'
  body+="harnesses detected: ${harnesses:-none}"$'\n'
  body+="failing rows:"$'\n'"$rows"
  # Home paths are personal; the issue is public.
  if [ -n "$HOME" ] && [ "$HOME" != / ]; then
    body="${body//"$HOME"/$tilde}"
  fi
  echo "[draft] to report this, run the next line yourself (install.sh never runs it):"
  echo "[draft] gh issue create --repo belajarcarabelajar/vivera --title \"install check: $CHECK_PROBLEMS problem(s)\" --body $(printf '%q' "$body")"
}

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
    check_row "[ok] $dir (sprite agents)"
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
    check_row "[FAIL] $id sprites: $refused"
  elif [ "${last#sprite agents are out of date:}" = "$last" ]; then
    check_row "[FAIL] $id sprites: ${first:-the generator exited $code without a message}"
  elif [ "$present" -eq 0 ]; then
    check_row "[missing] $dir (sprite agents)"
  else
    check_row "[stale] $dir (sprite agents are out of date or hand-edited; --update renders them again)"
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
    check_row "[skip] $id sprites: tier minimal renders none"
    sprite_unverified "tier minimal renders none"
  elif why="$(sprite_left_alone_why "$dir")"; then
    check_row "[skip] $id sprites: $dir $why; left alone"
    sprite_unverified "a sprite dir $why"
  elif ! tool_available bun; then
    check_row "[skip] $id sprites: bun not found"
    sprite_unverified "bun is missing"
  elif [ ! -d "$dir" ]; then
    check_row "[missing] $dir (sprite agents)"
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
  CHECK_COPIES_SEEN=false
  CHECK_FAILED_ROWS=""
  CHECK_BUN_VERSION="not found"

  selected="$(select_targets)"
  for id in $selected; do
    if [ "$(target_kind "$id")" = none ]; then
      check_row "[skip] $id: no skills target"
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
            check_row "[ok] $dest (inside this checkout)"
          else
            check_row "[foreign] $dest (inside this checkout, not the expected file)"
            CHECK_PROBLEMS=$((CHECK_PROBLEMS + 1))
          fi
          ;;
        viadir)
          # A real file of another tree, reached through a symlinked directory: not ours, left alone.
          check_row "[foreign] $dest (behind a symlinked directory; left alone)"
          CHECK_PROBLEMS=$((CHECK_PROBLEMS + 1))
          ;;
        absent)
          check_row "[missing] $dest"
          CHECK_PROBLEMS=$((CHECK_PROBLEMS + 1))
          ;;
        ok)
          if [ -e "$dest" ]; then
            check_row "[ok] $dest"
          else
            # The link is the right one, but the repo file it points to is gone.
            check_row "[dangling] $dest (its source is missing)"
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
              check_row "[dangling] $dest -> $target (expected $expected)"
            else
              check_row "[stale] $dest -> $target (expected $expected)"
            fi
          elif [ "${COPY_MODE:-false}" = true ]; then
            check_row "[stale] $dest (copy differs from $desired)"
          else
            check_row "[stale] $dest (a managed copy; expected a link to $desired)"
            CHECK_COPIES_SEEN=true
          fi
          CHECK_PROBLEMS=$((CHECK_PROBLEMS + 1))
          ;;
        foreign)
          if [ ! -L "$dest" ] && [ -e "$dest" ] && copy_managed "$dest"; then
            # The installer's own copy, edited since: --update moves it aside before refreshing it.
            check_row "[stale] $dest (copy edited since it was installed; --update moves it aside)"
          elif [ "${COPY_MODE:-false}" = true ]; then
            check_row "[foreign] $dest (not a vivera copy; --update would move it aside)"
          else
            check_row "[foreign] $dest (not a vivera link; --update would move it aside)"
          fi
          CHECK_PROBLEMS=$((CHECK_PROBLEMS + 1))
          ;;
      esac
    done 3< <(target_entries "$id")
    while IFS= read -r -u 4 stale; do
      if [ -n "$stale" ]; then
        check_row "[stale] $stale (a skill this checkout no longer has; --update prunes it)"
        CHECK_PROBLEMS=$((CHECK_PROBLEMS + 1))
      fi
    done 4<<< "$(stale_phase_dirs "$id")"
    check_sprites "$id"
  done
  check_machine_rows

  if [ "$CHECK_COPIES_SEEN" = true ]; then
    echo "[hint] those are copies made by --copy: run ./install.sh --check --copy"
  fi
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
  check_issue_draft
  echo "check: $CHECK_PROBLEMS problem(s)"
  exit 1
}
