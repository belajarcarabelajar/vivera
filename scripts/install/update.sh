# shellcheck shell=bash
# Sourced by install.sh: --update mode. It runs the install flow, so a dangling or legacy link is
# repointed, a user's own file is moved aside and a changed sprite agent is rendered again, and then
# it prunes the phase skills this checkout no longer has.

# Prunes what stale_phase_dirs (targets.sh) lists, the same list --check reports. The link (or, for a
# copy-mode directory, the SKILL.md and the marker) is removed, and the directory only when that left
# it empty: rmdir refuses a directory that still holds something, which is what keeps the user's files.
prune_stale_skills() {
  local id entry skill_md
  for id in $(select_targets); do
    while IFS= read -r -u 3 entry; do
      if [ -z "$entry" ]; then
        continue
      fi
      skill_md="$entry/SKILL.md"
      if [ "$DRY_RUN" = true ]; then
        echo "[DRY-RUN] Would prune $entry"
        continue
      fi
      rm -f "$skill_md" "$entry/.vivera-managed"
      if rmdir "$entry" 2>/dev/null; then
        echo "[PRUNED] $entry"
      else
        echo "[PRUNED] link removed from $entry; the directory stays because it holds other files"
      fi
    done 3<<< "$(stale_phase_dirs "$id")"
  done
}

mode_update() {
  install_targets
  install_selfcheck
  install_hooks
  prune_stale_skills
  sprites_exit_if_failed
  echo "==> Vivera updated: links and rendered agents match this checkout"
}
