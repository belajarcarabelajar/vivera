# shellcheck shell=bash
# Sourced by install.sh: --update mode. It runs the install flow, so a dangling or legacy link is
# repointed, a user's own file is moved aside and a changed sprite agent is rendered again, and then
# it prunes the phase skills this checkout no longer has.

# Prunes what stale_phase_dirs (targets.sh) lists, the same list --check reports. A link-mode leftover
# loses its link. A copy-mode directory (one with a .vivera-managed marker) loses its SKILL.md only while
# that is exactly what the installer placed (its digest still matches the marker's record): an edited
# SKILL.md, or one that is not a plain file, is the user's, so the directory stays with a KEEP line. The
# directory itself goes only when that left it empty: rmdir refuses one that still holds something.
prune_stale_skills() {
  local id entry skill_md recorded current
  for id in $(select_targets); do
    report_unusual_stale_names "$id"
    while IFS= read -r -u 3 entry; do
      if [ -z "$entry" ]; then
        continue
      fi
      skill_md="$entry/SKILL.md"
      if marker_regular "$entry/.vivera-managed"; then
        # The installer places a plain file in a marked dir; a symlink there (live or dangling) is the user's.
        if [ -L "$skill_md" ]; then
          echo "[KEEP] $entry (not a plain file)"
          continue
        fi
        if [ -e "$skill_md" ]; then
          recorded="$(recorded_digest "$skill_md")"
          current="$(entry_digest "$skill_md")"
          if [ -z "$current" ] || [ "$current" != "$recorded" ]; then
            echo "[KEEP] $entry (modified copy of a skill this checkout no longer has)"
            continue
          fi
        fi
      fi
      if [ "$DRY_RUN" = true ]; then
        echo "[DRY-RUN] Would prune $entry"
        continue
      fi
      rm -f "$skill_md"
      prune_stale_references "$entry"
      if marker_regular "$entry/.vivera-managed"; then
        rm -f "$entry/.vivera-managed"
      fi
      if rmdir "$entry" 2>/dev/null; then
        echo "[PRUNED] $entry"
      else
        echo "[PRUNED] link removed from $entry; the directory stays because it holds other files"
      fi
    done 3<<< "$(stale_phase_dirs "$id")"
  done
}

# Removes <entry>/references when the installer placed it, judged like SKILL.md above: in a marked
# copy dir a real directory whose digest still matches the marker's record, otherwise a vivera link.
# Anything else is the user's and stays, so the rmdir after this keeps the directory.
prune_stale_references() {
  local entry="$1"
  local refs="$1/references"
  local recorded current
  if [ ! -e "$refs" ] && [ ! -L "$refs" ]; then
    return 0
  fi
  if marker_regular "$entry/.vivera-managed"; then
    if [ -L "$refs" ] || [ ! -d "$refs" ]; then
      return 0
    fi
    recorded="$(recorded_digest "$refs")"
    current="$(entry_digest "$refs")"
    if [ -n "$current" ] && [ "$current" = "$recorded" ]; then
      rm -rf "$refs"
    fi
    return 0
  fi
  case "$(classify_dest "$refs" "$REPO_DIR/skills/$(basename "$entry")/references")" in
    ok | ours-stale) rm -f "$refs" ;;
  esac
}

# The closing line is sprites_exit_if_failed's to change: it ends the run with a failure, or with a count
# of the entries left alone, whenever that is the truth.
mode_update() {
  install_targets
  install_selfcheck
  install_hooks
  prune_stale_skills
  sprites_exit_if_failed
  finish_line "==> Vivera updated: links and rendered agents match this checkout"
}
