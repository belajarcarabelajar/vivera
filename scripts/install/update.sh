# shellcheck shell=bash
# Sourced by install.sh: --update mode. It runs the install flow, so a dangling or legacy link is
# repointed, a user's own file is moved aside and a changed sprite agent is rendered again, and then
# it prunes the phase skills this checkout no longer has.

# A phase skill that left skills/ leaves its <skills dir>/sucp-<name>/ behind in every harness, with
# a SKILL.md link that dangles. Only an entry named sucp-* is looked at, and only when the directory is real
# and either carries a .vivera-managed marker (a copy-mode directory) or has a SKILL.md symlink that
# is the installer's own (classify_dest ok or ours-stale). A user's real SKILL.md without a marker, a
# live link to a file elsewhere, and a skill the checkout still has are never touched.
prune_stale_skills() {
  local id dir parent entry name skill_md state
  for id in $(select_targets); do
    if [ "$(target_kind "$id")" != package ]; then
      continue
    fi
    dir="$(target_skills_dir "$id")"
    parent="$(dirname "$dir")"
    for entry in "$parent"/sucp-*; do
      if [ ! -d "$entry" ] || [ -L "$entry" ]; then
        continue
      fi
      name="$(basename "$entry")"
      if [ -e "$REPO_DIR/skills/$name" ]; then
        continue
      fi
      skill_md="$entry/SKILL.md"
      if [ -f "$entry/.vivera-managed" ]; then
        # A copy-mode directory: the marker says the whole directory is the installer's own.
        if [ "$DRY_RUN" = true ]; then
          echo "[DRY-RUN] Would prune $entry"
        else
          rm -f "$skill_md" "$entry/.vivera-managed"
          rmdir "$entry" 2>/dev/null || true
          echo "[PRUNED] $entry"
        fi
        continue
      fi
      if [ ! -L "$skill_md" ]; then
        continue
      fi
      state="$(classify_dest "$skill_md" "$REPO_DIR/skills/$name/SKILL.md")"
      case "$state" in
        ok | ours-stale) ;;
        *) continue ;;
      esac
      if [ "$DRY_RUN" = true ]; then
        echo "[DRY-RUN] Would prune $entry"
      else
        rm -f "$skill_md"
        # rmdir refuses a directory that still holds something, which is what keeps the user's files.
        rmdir "$entry" 2>/dev/null || true
        echo "[PRUNED] $entry"
      fi
    done
  done
}

mode_update() {
  install_targets
  install_selfcheck
  install_hooks
  prune_stale_skills
  echo "==> Vivera updated: links and rendered agents match this checkout"
}
