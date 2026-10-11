# shellcheck shell=bash
# Sourced by install.sh: the target table, the target selection, and the install steps.

# --- The target table -------------------------------------------------------------------------
# One row per harness, in install order. A harness is "present" when its dir exists under HOME or
# its CLI is on PATH. ai-config and agents are the baseline every machine gets; the rest are
# installed only when present or named with --only. codex, cursor and copilot read their skills
# from ~/.agents/skills, so they have no skills dir of their own (they gain sprites in a later task).

target_ids() {
  printf '%s\n' ai-config agents antigravity antigravity-cli antigravity-builtin gemini-cli opencode claude codex cursor copilot
}

target_skills_dir() {
  case "$1" in
    ai-config) echo "$HOME/.config/ai" ;;
    agents) echo "$HOME/.agents/skills/super-ultra-code-plan" ;;
    antigravity) echo "$HOME/.gemini/config/skills/super-ultra-code-plan" ;;
    antigravity-cli) echo "$HOME/.gemini/antigravity-cli/skills/super-ultra-code-plan" ;;
    antigravity-builtin) echo "$HOME/.gemini/antigravity-cli/builtin/skills/super-ultra-code-plan" ;;
    gemini-cli) echo "$HOME/.gemini/skills/super-ultra-code-plan" ;;
    opencode) echo "$HOME/.config/opencode/skills/super-ultra-code-plan" ;;
    claude) echo "$HOME/.claude/skills/super-ultra-code-plan" ;;
    codex | cursor | copilot) echo "" ;;
    *) return 1 ;;
  esac
}

# file: one master-file link; package: the skill package dir; none: no skills target.
target_kind() {
  case "$1" in
    ai-config) echo "file" ;;
    codex | cursor | copilot) echo "none" ;;
    agents | antigravity | antigravity-cli | antigravity-builtin | gemini-cli | opencode | claude) echo "package" ;;
    *) return 1 ;;
  esac
}

# Exit 0 when the harness is present on this machine.
target_detected() {
  case "$1" in
    ai-config | agents) return 0 ;;
    antigravity) [ -d "$HOME/.gemini" ] || tool_available agy ;;
    antigravity-cli) [ -d "$HOME/.gemini/antigravity-cli" ] || tool_available agy ;;
    antigravity-builtin) [ -d "$HOME/.gemini/antigravity-cli/builtin/skills" ] ;;
    gemini-cli) tool_available gemini ;;
    opencode) [ -d "$HOME/.config/opencode" ] || tool_available opencode ;;
    claude) [ -d "$HOME/.claude" ] ;;
    codex) [ -d "$HOME/.codex" ] || tool_available codex ;;
    cursor) [ -d "$HOME/.cursor" ] || tool_available cursor-agent ;;
    copilot) [ -d "$HOME/.copilot" ] || tool_available copilot ;;
    *) return 1 ;;
  esac
}

# The links a target makes, one "<desired><TAB><dest>" line each (see package_entries in lib.sh):
# one line for ai-config, the whole package for a package target, nothing for a target without skills.
target_entries() {
  local id="$1"
  local dir
  dir="$(target_skills_dir "$id")"
  case "$(target_kind "$id")" in
    file) printf '%s\t%s\n' "$MASTER_FILE" "$dir/Super Ultra Code Plan Implementation.md" ;;
    package) package_entries "$dir" ;;
    none) ;;
  esac
}

is_target_id() {
  local want="$1"
  local id
  while IFS= read -r id; do
    if [ "$id" = "$want" ]; then
      return 0
    fi
  done <<< "$(target_ids)"
  return 1
}

# "ai-config, agents, ..." for messages.
valid_target_list() {
  local id
  local out=""
  while IFS= read -r id; do
    out="${out:+$out, }$id"
  done <<< "$(target_ids)"
  echo "$out"
}

# ONLY and SKIP are comma lists set by install.sh (SKIP wins over ONLY).
list_has() {
  case ",$1," in
    *",$2,"*) return 0 ;;
  esac
  return 1
}

# The ids to act on, one per line, in table order: exactly the --only ids when given (even if the
# harness is absent), otherwise every present harness; then the --skip ids are removed.
select_targets() {
  local id
  while IFS= read -r id; do
    if [ -n "${ONLY:-}" ]; then
      list_has "$ONLY" "$id" || continue
    elif ! target_detected "$id"; then
      continue
    fi
    if [ -n "${SKIP:-}" ] && list_has "$SKIP" "$id"; then
      continue
    fi
    echo "$id"
  done <<< "$(target_ids)"
}

# The phase-skill dirs of a package target that this checkout no longer has, one per line. A phase
# skill that left skills/ leaves its <skills dir>/sucp-<name>/ behind in every harness. Only a sucp-*
# entry that is a real directory is considered, and only when it is the installer's own: it carries a
# .vivera-managed marker (a copy-mode directory), or its SKILL.md is a symlink that classify_dest calls
# ok or ours-stale. A directory inside this checkout, a user's real SKILL.md without a marker, a live
# link to a file elsewhere, and a skill the checkout still has are never listed. Both --check (which
# reports them) and --update (which prunes them) read this one list.
stale_phase_dirs() {
  local id="$1"
  local parent entry name skill_md state
  if [ "$(target_kind "$id")" != package ]; then
    return 0
  fi
  parent="$(dirname "$(target_skills_dir "$id")")"
  for entry in "$parent"/sucp-*; do
    if [ ! -d "$entry" ] || [ -L "$entry" ]; then
      continue
    fi
    name="$(basename "$entry")"
    if [ -e "$REPO_DIR/skills/$name" ]; then
      continue
    fi
    skill_md="$entry/SKILL.md"
    if dest_in_repo "$skill_md"; then
      continue
    fi
    if [ -f "$entry/.vivera-managed" ]; then
      echo "$entry"
      continue
    fi
    if [ ! -L "$skill_md" ]; then
      continue
    fi
    state="$(classify_dest "$skill_md" "$REPO_DIR/skills/$name/SKILL.md")"
    case "$state" in
      ok | ours-stale) echo "$entry" ;;
    esac
  done
}

# --- Install ----------------------------------------------------------------------------------

# Sprite agents exist for two harnesses so far. Tier minimal renders none (the generator needs bun).
install_sprites() {
  if [ "$TIER" = minimal ]; then
    return 0
  fi
  case "$1" in
    opencode)
      # OpenCode subagents (~/.config/opencode/agents/). The same Harvest Sprite
      # crew in the OpenCode v2 format: hex colors, steps, and shell permission
      # rules in place of the git guard hook, which OpenCode cannot run. OpenCode
      # skips a Claude Code agent file without a message, so the two are rendered
      # separately. Only files carrying the generator's marker are written or removed.
      # Revert: rm the files in ~/.config/opencode/agents/ whose frontmatter has the
      # "# Generated by scripts/gen-sprite-agents.mjs" line.
      if [ "$DRY_RUN" = true ]; then
        echo "[DRY-RUN] Would render the sprite agents into: $HOME/.config/opencode/agents (OpenCode format)"
      else
        bun "$REPO_DIR/scripts/gen-sprite-agents.mjs" --target opencode --out "$HOME/.config/opencode/agents"
      fi
      ;;
    claude)
      # Claude Code subagents (~/.claude/agents/). The Harvest Sprite crew is
      # rendered, not linked: a user-level agent runs in every project, where
      # $CLAUDE_PROJECT_DIR is that project and has no git guard hook, so the hook
      # path is pinned to this repository. Only files carrying the generator's
      # marker are written or removed; hand-written agents are left alone.
      # Revert: rm the files in ~/.claude/agents/ whose frontmatter has the
      # "# Generated by scripts/gen-sprite-agents.mjs" line.
      if [ "$DRY_RUN" = true ]; then
        echo "[DRY-RUN] Would render the sprite agents into: $HOME/.claude/agents (hook root $REPO_DIR)"
      else
        bun "$REPO_DIR/scripts/gen-sprite-agents.mjs" --out "$HOME/.claude/agents" --hook-root "$REPO_DIR"
      fi
      ;;
  esac
}

install_one_target() {
  local id="$1"
  local dir dest
  dir="$(target_skills_dir "$id")"
  case "$(target_kind "$id")" in
    file)
      IFS=$'\t' read -r _ dest <<< "$(target_entries "$id")"
      link_target "$(dirname "$dest")" "$dest"
      ;;
    package)
      link_skill_package "$dir"
      install_sprites "$id"
      ;;
    none)
      echo "[SKIP] $id: its skills come from ~/.agents/skills; no skills target"
      ;;
  esac
}

install_targets() {
  local selected id
  selected="$(select_targets)"
  for id in $selected; do
    install_one_target "$id"
  done
  # One line covers every harness that would have rendered sprites; it prints at tier minimal
  # whether or not such a harness was selected, as it always has.
  if [ "$TIER" = minimal ]; then
    echo "[SKIP] sprite agents: tier minimal needs no bun"
  fi

  # 6b. Retired 2026-10-01 — the vendored `use-tinyfish` skill is gone.
  #     TinyFish is now documented inline in the master skill
  #     ("Super Ultra Code Plan Implementation.md", section
  #     "Web Evidence & Retrieval — TinyFish"), so the whole super-ultra-code-plan
  #     package carries the escalation ladder wherever it is deployed. A separate
  #     skill created drift: two sources of truth documenting different tool
  #     surfaces, and the CLI copy never described the MCP tools agents actually call.
  #     Revert: restore this block, restore `skills/use-tinyfish/SKILL.md` from git
  #     history at the pre-2026-10-01 commit, and re-run ./install.sh. Cleanup for
  #     already-deployed copies: `rm -f` the SKILL.md symlinks under
  #     ~/.agents/skills/use-tinyfish/, ~/.config/opencode/skills/use-tinyfish/,
  #     ~/.gemini/config/skills/use-tinyfish/ and
  #     ~/.gemini/antigravity-cli/builtin/skills/use-tinyfish/, then `rmdir` the
  #     empty dirs. They are symlinks into this repo, so removing the target breaks
  #     them without touching real content.
}

# 7. Local Repo Self-Check
install_selfcheck() {
  # Copy mode installs files, not links into this checkout, so its own relative links are not part of it.
  if [ "${COPY_MODE:-false}" = true ]; then
    echo "[SKIP] internal repo links: copy mode"
  elif [ "$DRY_RUN" = true ]; then
    echo "[DRY-RUN] Would verify internal skill package in: $REPO_DIR/skills/super-ultra-code-plan"
    echo "[DRY-RUN]   - SKILL.md -> ../../Super Ultra Code Plan Implementation.md"
    echo "[DRY-RUN]   - templates -> ../../templates"
    echo "[DRY-RUN]   - examples -> ../../examples"
    echo "[DRY-RUN]   - mermaid.config.json -> ../../mermaid.config.json"
    echo "[DRY-RUN]   - mermaid.dark.config.json -> ../../mermaid.dark.config.json"
  else
    local package_dir="$REPO_DIR/skills/super-ultra-code-plan"
    local entry name relative_target
    # name|relative target, in the order the dry-run block above lists them.
    local internal_links=(
      "SKILL.md|../../Super Ultra Code Plan Implementation.md"
      "templates|../../templates"
      "examples|../../examples"
      "mermaid.config.json|../../mermaid.config.json"
      "mermaid.dark.config.json|../../mermaid.dark.config.json"
    )
    mkdir -p "$package_dir"
    for entry in "${internal_links[@]}"; do
      place_repo_link "${entry#*|}" "$package_dir/${entry%%|*}"
    done
    # Verify before claiming it: each link must resolve and carry the expected relative target.
    for entry in "${internal_links[@]}"; do
      name="${entry%%|*}"
      relative_target="${entry#*|}"
      if [ ! -e "$package_dir/$name" ] || [ "$(readlink "$package_dir/$name")" != "$relative_target" ]; then
        echo "[FAIL] internal repo skill package link $name does not resolve" >&2
        exit 1
      fi
    done
    echo "[OK] Internal repo skill package symlinks verified."
  fi
}

# 8. Enable the committed git hooks. `.githooks/pre-commit` keeps the repo's
#    graph consistent with each commit: when code changed it runs
#    `graphify update .` (local AST), then `bun run graphify:sync` adds the
#    Markdown's structural nodes last. A Markdown-only commit pays only for the
#    sync. core.hooksPath is repo-local config, so this changes nothing outside
#    this checkout and is undone with one unset. The hook itself never blocks a
#    commit: every path exits 0, because the graph is derived state.
#    graphify is an optional tool, so when it is absent install.sh skips this
#    setup entirely: the hook would only print its one-line "graphify CLI not
#    found" note, the same no-op it already performs on machines without it.
#    Tier minimal skips the step: it needs git, which that tier does not require. A copy of this
#    repo inside some other git repo (no .git of its own) is skipped too: core.hooksPath would be
#    written into the outer repo's config, which is not this installer's to change.
install_hooks() {
  if [ "$TIER" = minimal ]; then
    echo "[SKIP] git hooks: tier minimal needs no git"
  elif ! tool_available graphify; then
    echo "⚠️  WARNING: optional tool 'graphify' not found; skipping core.hooksPath setup (the pre-commit hook no-ops without graphify anyway)." >&2
  elif [ "$(git -C "$REPO_DIR" rev-parse --show-toplevel 2>/dev/null)" = "$(cd -P "$REPO_DIR" && pwd -P)" ]; then
    if [ "$DRY_RUN" = true ]; then
      echo "[DRY-RUN] Would set repo-local git config: core.hooksPath=.githooks"
      echo "[DRY-RUN]   - .githooks/pre-commit -> non-blocking: graphify update (code) then graphify:sync (docs)"
    else
      git -C "$REPO_DIR" config core.hooksPath .githooks
      echo "[OK] Enabled git hooks: core.hooksPath=.githooks"
      echo "     (revert: git -C \"$REPO_DIR\" config --unset core.hooksPath)"
    fi
  else
    echo "[SKIP] Not a git checkout of its own; skipping core.hooksPath (the hook is opt-in)."
  fi
}
