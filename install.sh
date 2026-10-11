#!/usr/bin/env bash
# install.sh - Plant the Vivera skill farm: symlink the Ultimate All-in-One AI Coding Agent Skill into every harness
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MASTER_FILE="$REPO_DIR/Super Ultra Code Plan Implementation.md"
DRY_RUN=false
TIER=standard

usage() {
  cat <<'EOF'
Usage: ./install.sh [--tier minimal|standard|full] [--dry-run] [-h]
  --tier T    prerequisite level, default standard. The tool table is scripts/install/tiers.tsv.
                minimal   requires no tool; links the skills only (no sprite agents, no git hooks)
                standard  requires git and bun
                full      also requires gh and tgrep
  --dry-run   print what would be done and write nothing
  -h, --help  print this text
Links the master skill into ~/.config/ai, ~/.agents/skills, ~/.gemini, and
~/.config/opencode/skills, plus ~/.claude only when that harness is installed.
A tool the chosen tier does not require prints one warning naming what is lost and is skipped.
TinyFish web-evidence rules ship inside the master skill; no extra skill is deployed.
Exit codes: 0 success, 1 failure (a required tool is missing), 2 usage error.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      ;;
    --tier)
      if [ $# -lt 2 ]; then
        echo "Invalid tier: (no value after --tier)" >&2
        usage >&2
        exit 2
      fi
      TIER="$2"
      shift
      ;;
    --tier=*)
      TIER="${1#--tier=}"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

case "$TIER" in
  minimal|standard|full) ;;
  *)
    echo "Invalid tier: $TIER" >&2
    usage >&2
    exit 2
    ;;
esac

echo "==> Sowing Vivera: configuring the Ultimate All-in-One AI Coding Agent Skill..."
echo "    Source: $MASTER_FILE"
echo "    Tier: $TIER"

# 0. Prerequisites Check. Which tools are hard requirements depends on --tier and
#    lives in scripts/install/tiers.tsv (standard: git and bun). Every other tool
#    is optional: a missing one costs one capability, so install.sh warns (naming
#    what is lost) and continues.

tool_available() {
  # Single source of truth for "can we call $cmd". Beyond the current PATH it
  # probes the two standard fallback dirs and, when found there, prepends that
  # dir to PATH so every later `$cmd` invocation works. Optional-tool warnings
  # fire only when all three probes fail.
  local cmd="$1"
  if command -v "$cmd" &>/dev/null; then
    return 0
  fi
  if [ -x "$HOME/.local/bin/$cmd" ]; then
    export PATH="$HOME/.local/bin:$PATH"
    return 0
  fi
  if [ -x "$HOME/.bun/bin/$cmd" ]; then
    export PATH="$HOME/.bun/bin:$PATH"
    return 0
  fi
  return 1
}

check_prereq() {
  local cmd="$1"
  local label="$2"
  local min_hint="${3:-}"

  if ! tool_available "$cmd"; then
    echo "❌ Missing prerequisite: '$cmd' ($label) is mandatory." >&2
    [ -n "$min_hint" ] && echo "   Hint: $min_hint" >&2
    echo "   Install to ~/.local/bin/$cmd, ~/.bun/bin/$cmd, or system PATH." >&2
    exit 1
  fi
  local version
  version="$($cmd --version 2>&1 | head -n 1)"
  [ -z "$version" ] && version="installed (no version flag)"
  echo "[OK] Prerequisite verified: $cmd — $version"
}

# Optional tool: warn once with the lost capability named, then move on. When
# present it reports exactly like a hard prerequisite (same [OK] line).
check_optional() {
  local cmd="$1"
  local loss="$2"

  if ! tool_available "$cmd"; then
    echo "⚠️  WARNING: optional tool '$cmd' not found; $loss" >&2
    return 0
  fi
  check_prereq "$cmd" "optional tool"
}

# shellcheck source=scripts/install/prereq.sh
. "$REPO_DIR/scripts/install/prereq.sh"
check_tier_prereqs "$TIER" "$REPO_DIR/scripts/install/tiers.tsv"

link_target() {
  local target_dir="$1"
  local target_file="$2"

  if [ "$DRY_RUN" = true ]; then
    echo "[DRY-RUN] Would create directory: $target_dir"
    echo "[DRY-RUN] Would link: $target_file -> $MASTER_FILE"
  else
    mkdir -p "$target_dir"
    ln -sf "$MASTER_FILE" "$target_file"
    echo "[OK] Linked: $target_file -> $MASTER_FILE"
  fi
}

link_skill_package() {
  local target_skill_dir="$1"

  if [ "$DRY_RUN" = true ]; then
    echo "[DRY-RUN] Would configure skill package in: $target_skill_dir"
    echo "[DRY-RUN]   - SKILL.md -> $MASTER_FILE"
    echo "[DRY-RUN]   - templates -> $REPO_DIR/templates"
    echo "[DRY-RUN]   - examples -> $REPO_DIR/examples"
    echo "[DRY-RUN]   - mermaid.config.json -> $REPO_DIR/mermaid.config.json"
    echo "[DRY-RUN]   - mermaid.dark.config.json -> $REPO_DIR/mermaid.dark.config.json"
    echo "[DRY-RUN]   - phase skills -> $(dirname "$target_skill_dir")/sucp-*/SKILL.md"
  else
    mkdir -p "$target_skill_dir"
    ln -sf "$MASTER_FILE" "$target_skill_dir/SKILL.md"
    # Phase skills are siblings of the orchestrator, so each harness discovers
    # them by name and the orchestrator can load them with the skill tool.
    for phase_dir in "$REPO_DIR"/skills/sucp-*; do
      phase_name="$(basename "$phase_dir")"
      mkdir -p "$(dirname "$target_skill_dir")/$phase_name"
      ln -sf "$phase_dir/SKILL.md" "$(dirname "$target_skill_dir")/$phase_name/SKILL.md"
    done
    ln -sfn "$REPO_DIR/templates" "$target_skill_dir/templates"
    ln -sfn "$REPO_DIR/examples" "$target_skill_dir/examples"
    # Theming config ships with the skill so an installed harness can reproduce
    # the same diagram rendering (font embedding, palette, dark variant).
    ln -sf "$REPO_DIR/mermaid.config.json" "$target_skill_dir/mermaid.config.json"
    ln -sf "$REPO_DIR/mermaid.dark.config.json" "$target_skill_dir/mermaid.dark.config.json"
    echo "[OK] Linked skill package in: $target_skill_dir"
  fi
}

# 1. Personal AI config directory (~/.config/ai/)
link_target "$HOME/.config/ai" "$HOME/.config/ai/Super Ultra Code Plan Implementation.md"

# 2. Universal Agent Skills (~/.agents/skills/super-ultra-code-plan/)
link_skill_package "$HOME/.agents/skills/super-ultra-code-plan"

# 3. Gemini / Antigravity User Skills (~/.gemini/config/skills/super-ultra-code-plan/)
link_skill_package "$HOME/.gemini/config/skills/super-ultra-code-plan"

# 4. Antigravity CLI builtin fallback (~/.gemini/antigravity-cli/builtin/skills/)
if [ -d "$HOME/.gemini/antigravity-cli/builtin/skills" ]; then
  link_skill_package "$HOME/.gemini/antigravity-cli/builtin/skills/super-ultra-code-plan"
fi

# 5. OpenCode (optional prereq, but the target is always populated). With
#    OpenCode installed the skill is discoverable outside the repo cwd; without
#    it the copy sits unused until OpenCode is installed.
link_skill_package "$HOME/.config/opencode/skills/super-ultra-code-plan"

# 5a. OpenCode subagents (~/.config/opencode/agents/). The same Harvest Sprite
#     crew in the OpenCode v2 format: hex colors, steps, and shell permission
#     rules in place of the git guard hook, which OpenCode cannot run. OpenCode
#     skips a Claude Code agent file without a message, so the two are rendered
#     separately. Only files carrying the generator's marker are written or removed.
#     Revert: rm the files in ~/.config/opencode/agents/ whose frontmatter has the
#     "# Generated by scripts/gen-sprite-agents.mjs" line.
#     Tier minimal skips this step and 6a (the generator needs bun); one [SKIP] line covers both.
if [ "$TIER" = minimal ]; then
  echo "[SKIP] sprite agents: tier minimal needs no bun"
elif [ "$DRY_RUN" = true ]; then
  echo "[DRY-RUN] Would render the sprite agents into: $HOME/.config/opencode/agents (OpenCode format)"
else
  bun "$REPO_DIR/scripts/gen-sprite-agents.mjs" --target opencode --out "$HOME/.config/opencode/agents"
fi

# 6. Claude Code directory (~/.claude/skills/). Optional harness: only linked when
#    already installed, so a missing ~/.claude never gets fabricated here.
if [ -d "$HOME/.claude" ]; then
  link_skill_package "$HOME/.claude/skills/super-ultra-code-plan"
fi

# 6a. Claude Code subagents (~/.claude/agents/). The Harvest Sprite crew is
#     rendered, not linked: a user-level agent runs in every project, where
#     $CLAUDE_PROJECT_DIR is that project and has no git guard hook, so the hook
#     path is pinned to this repository. Only files carrying the generator's
#     marker are written or removed; hand-written agents are left alone.
#     Revert: rm the files in ~/.claude/agents/ whose frontmatter has the
#     "# Generated by scripts/gen-sprite-agents.mjs" line.
if [ "$TIER" != minimal ] && [ -d "$HOME/.claude" ]; then
  if [ "$DRY_RUN" = true ]; then
    echo "[DRY-RUN] Would render the sprite agents into: $HOME/.claude/agents (hook root $REPO_DIR)"
  else
    bun "$REPO_DIR/scripts/gen-sprite-agents.mjs" --out "$HOME/.claude/agents" --hook-root "$REPO_DIR"
  fi
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

# 7. Local Repo Self-Check
if [ "$DRY_RUN" = true ]; then
  echo "[DRY-RUN] Would verify internal skill package in: $REPO_DIR/skills/super-ultra-code-plan"
  echo "[DRY-RUN]   - SKILL.md -> ../../Super Ultra Code Plan Implementation.md"
  echo "[DRY-RUN]   - templates -> ../../templates"
  echo "[DRY-RUN]   - examples -> ../../examples"
  echo "[DRY-RUN]   - mermaid.config.json -> ../../mermaid.config.json"
  echo "[DRY-RUN]   - mermaid.dark.config.json -> ../../mermaid.dark.config.json"
else
  mkdir -p "$REPO_DIR/skills/super-ultra-code-plan"
  ln -sf "../../Super Ultra Code Plan Implementation.md" "$REPO_DIR/skills/super-ultra-code-plan/SKILL.md"
  ln -sfn "../../templates" "$REPO_DIR/skills/super-ultra-code-plan/templates"
  ln -sfn "../../examples" "$REPO_DIR/skills/super-ultra-code-plan/examples"
  ln -sf "../../mermaid.config.json" "$REPO_DIR/skills/super-ultra-code-plan/mermaid.config.json"
  ln -sf "../../mermaid.dark.config.json" "$REPO_DIR/skills/super-ultra-code-plan/mermaid.dark.config.json"
  echo "[OK] Internal repo skill package symlinks verified."
fi

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
#    Tier minimal skips the step: it needs git, which that tier does not require.
if [ "$TIER" = minimal ]; then
  echo "[SKIP] git hooks: tier minimal needs no git"
elif ! tool_available graphify; then
  echo "⚠️  WARNING: optional tool 'graphify' not found; skipping core.hooksPath setup (the pre-commit hook no-ops without graphify anyway)." >&2
elif git -C "$REPO_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  if [ "$DRY_RUN" = true ]; then
    echo "[DRY-RUN] Would set repo-local git config: core.hooksPath=.githooks"
    echo "[DRY-RUN]   - .githooks/pre-commit -> non-blocking: graphify update (code) then graphify:sync (docs)"
  else
    git -C "$REPO_DIR" config core.hooksPath .githooks
    echo "[OK] Enabled git hooks: core.hooksPath=.githooks"
    echo "     (revert: git -C \"$REPO_DIR\" config --unset core.hooksPath)"
  fi
else
  echo "[SKIP] Not a git checkout; skipping core.hooksPath (the hook is opt-in)."
fi

echo "==> Vivera farm planted: the Ultimate AI Coding Skill installation is complete!"
