# shellcheck shell=bash
# Sourced by install.sh: --update mode. It runs the install flow, so a dangling or legacy link is
# repointed, a user's own file is moved aside and a changed sprite agent is rendered again, and then
# it prunes the phase skills this checkout no longer has, and what was installed under the old names.

# Prunes what stale_phase_dirs (targets.sh) lists, the same list --check reports, for every selected target.
prune_stale_skills() {
  local id
  for id in $(select_targets); do
    prune_stale_target "$id"
  done
}

# The prune of one target; --uninstall calls it too. A link (a phase dir linked whole, or the old ai-config
# file) is removed as a link, never followed. The old ai-config copy goes with its sidecar only while its
# digest still matches the sidecar's record. A directory loses each entry that is the installer's own: a
# link classify_dest calls ok or ours-stale, or, in a copy-mode directory (one with a .vivera-managed marker),
# a plain entry whose digest still matches the marker's record. A marked directory whose SKILL.md was edited,
# or is not a plain file, is the user's, so it stays whole with a KEEP line. The directory itself goes only
# when that left it empty: rmdir refuses one that still holds something.
prune_stale_target() {
  local id="$1"
  local entry skill_md
  report_unusual_stale_names "$id"
  while IFS= read -r -u 3 entry; do
    if [ -z "$entry" ]; then
      continue
    fi
    skill_md="$entry/SKILL.md"
    if [ ! -L "$entry" ] && [ -f "$entry" ] && ! owned_copy "$entry"; then
      echo "[KEEP] $entry (modified copy of a skill this checkout no longer has)"
      continue
    fi
    if [ ! -L "$entry" ] && marker_regular "$entry/.vivera-managed"; then
      # The installer places a plain file in a marked dir; a symlink there (live or dangling) is the user's.
      if [ -L "$skill_md" ]; then
        echo "[KEEP] $entry (not a plain file)"
        continue
      fi
      if [ -e "$skill_md" ] && ! owned_copy "$skill_md"; then
        echo "[KEEP] $entry (modified copy of a skill this checkout no longer has)"
        continue
      fi
    fi
    if [ "$DRY_RUN" = true ]; then
      echo "[DRY-RUN] Would prune $entry"
      continue
    fi
    if [ -L "$entry" ] || [ -f "$entry" ]; then
      rm -f "$entry"
      if marker_regular "$entry.vivera-managed"; then
        rm -f "$entry.vivera-managed"
      fi
      echo "[PRUNED] $entry"
      continue
    fi
    prune_owned_entries "$entry"
    if marker_regular "$entry/.vivera-managed"; then
      rm -f "$entry/.vivera-managed"
    fi
    if rmdir "$entry" 2>/dev/null; then
      echo "[PRUNED] $entry"
    else
      echo "[PRUNED] link removed from $entry; the directory stays because it holds other files"
    fi
  done 3<<< "$(stale_phase_dirs "$id")"
}

# True when the plain file or directory at <path> is exactly what the installer placed: its digest equals
# the one its marker (or sidecar) recorded. An empty digest never matches.
owned_copy() {
  local recorded current
  recorded="$(recorded_digest "$1")"
  current="$(entry_digest "$1")"
  [ -n "$current" ] && [ "$current" = "$recorded" ]
}

# Removes each entry of the stale directory <dir> that the installer placed (see prune_stale_target).
# Hidden entries are never the installer's, apart from the marker, which the caller handles.
prune_owned_entries() {
  local dir="$1"
  local child
  for child in "$dir"/*; do
    if [ -L "$child" ]; then
      # The installer places plain copies in a marked dir, so a link there is the user's.
      if marker_regular "$dir/.vivera-managed"; then
        continue
      fi
      case "$(COPY_MODE=false classify_dest "$child" "$REPO_DIR/skills/$(basename "$dir")/$(basename "$child")")" in
        ok | ours-stale) rm -f "$child" ;;
      esac
    elif [ -e "$child" ] && marker_regular "$dir/.vivera-managed" && owned_copy "$child"; then
      rm -rf "$child"
    fi
  done
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
