# shellcheck shell=bash
# Sourced by install.sh: tool probing and the link primitives shared by every mode.

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
