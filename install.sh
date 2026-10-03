#!/usr/bin/env bash
# install.sh — Setup symlinks for the Ultimate All-in-One AI Coding Agent Skill
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MASTER_FILE="$REPO_DIR/Super Ultra Code Plan Implementation.md"
DRY_RUN=false

for arg in "$@"; do
  case "$arg" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
    echo "Usage: ./install.sh [--dry-run]"
    echo "Links the master skill into ~/.config/ai, ~/.agents/skills, ~/.gemini, and"
    echo "~/.config/opencode/skills, plus ~/.claude only when that harness is installed."
    echo "Hard prerequisites: git, bun. Optional: tgrep, context-mode, rtk, gh, opencode,"
    echo "snipset, graphify; a missing optional tool prints one warning and is skipped."
    echo "TinyFish web-evidence rules ship inside the master skill; no extra skill is deployed."
      exit 0
      ;;
  esac
done

echo "==> Configuring Ultimate All-in-One AI Coding Agent Skill..."
echo "    Source: $MASTER_FILE"

# 0. Prerequisites Check. Hard requirements: git and bun only. Everything else
#    the skill uses is optional: a missing tool costs one capability, so
#    install.sh warns (naming what is lost) and continues.

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

check_prereq "git"           "version control (repo self-check, core.hooksPath setup)"
check_prereq "bun"           "Bun >= 1.1.0 (mandatory JS/TS runtime; bun install / bun test / bun run)" \
             "curl -fsSL https://bun.sh/install | bash"
check_optional "tgrep"        "trigram-indexed code search is unavailable; the skill falls back to plain rg"
check_optional "context-mode" "ctx_execute / ctx_batch_execute token-efficient routing is unavailable; large outputs enter context unfiltered"
check_optional "rtk"          "the rtk output-compressing proxy is unavailable; dev ops run unproxied"
check_optional "gh"           "GitHub operations are unavailable; plan.issues.json issue sync and gh-backed web search degrade"
check_optional "opencode"     "the OpenCode harness is unavailable; the skill copy under ~/.config/opencode/skills stays dormant until OpenCode is installed"
check_optional "snipset"      "the Snipset database and MCP tools are unavailable; the snippets/ drift guard skips instead of comparing"
check_optional "graphify"     "knowledge-graph query/update commands are unavailable; the pre-commit graph refresh no-ops and 'graphify update .' must run manually"

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
  else
    mkdir -p "$target_skill_dir"
    ln -sf "$MASTER_FILE" "$target_skill_dir/SKILL.md"
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

# 6. Claude Code directory (~/.claude/skills/). Optional harness: only linked when
#    already installed, so a missing ~/.claude never gets fabricated here.
if [ -d "$HOME/.claude" ]; then
  link_skill_package "$HOME/.claude/skills/super-ultra-code-plan"
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
if ! tool_available graphify; then
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

echo "==> Ultimate AI Coding Skill installation complete!"
