#!/usr/bin/env bash
# Runs inside the tmux window lan-claude opens. One argument: the job id. The prompt is read from the
# job folder (never from argv of the server). No --permission-mode flag: the session uses the same
# settings.json as one opened by hand, so it follows whatever default mode that file sets. The lan-claude
# hooks are added on top through a per-job settings file; in default mode they put permission requests
# on the phone, in bypass mode there is nothing to ask.
#
# Environment: LAN_CLAUDE_STATE_DIR (default ~/.local/state/lan-claude), LAN_CLAUDE_CLAUDE_BIN and
# LAN_CLAUDE_BUN (default: found on PATH).
set -u
job="${1:-}"
[[ "$job" =~ ^[a-f0-9]{12}$ ]] || { echo "lan-claude: bad job id"; exit 2; }

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="${LAN_CLAUDE_STATE_DIR:-$HOME/.local/state/lan-claude}"
CLAUDE="${LAN_CLAUDE_CLAUDE_BIN:-$(command -v claude || true)}"
BUN="${LAN_CLAUDE_BUN:-$(command -v bun || true)}"
[ -n "$CLAUDE" ] && [ -x "$CLAUDE" ] || { echo "lan-claude: claude not found (set LAN_CLAUDE_CLAUDE_BIN)"; exit 2; }
[ -n "$BUN" ] && [ -x "$BUN" ] || { echo "lan-claude: bun not found (set LAN_CLAUDE_BUN)"; exit 2; }
# The paths go into a sed replacement below: refuse characters that would break it.
case "$APP$BUN" in *"|"* | *"&"* | *"\\"*) echo "lan-claude: a path contains | & or a backslash"; exit 2 ;; esac

dir="$STATE/jobs/$job"
prompt="$(cat "$dir/prompt.txt" 2>/dev/null)" || { echo "lan-claude: no prompt for $job"; exit 2; }
[ -n "$prompt" ] || { echo "lan-claude: empty prompt"; exit 2; }

# Optional model for this session only (written by lan-claude from /model on the phone).
model_args=()
model="$(tr -d '[:space:]' < "$dir/model.txt" 2>/dev/null)"
if [[ "$model" =~ ^(sonnet|opus|haiku|fable|claude-[a-z0-9-]+(\[1m\])?)$ ]]; then model_args=(--model "$model"); fi

effort="$(tr -d '[:space:]' < "$dir/effort.txt" 2>/dev/null)"
if [[ "$effort" =~ ^(low|medium|high|xhigh|max)$ ]]; then model_args+=(--effort "$effort"); fi

# Hook settings for this job: the template with the bun binary and this folder filled in.
settings="$dir/settings.json"
sed -e "s|__BUN__|$BUN|g" -e "s|__APP__|$APP|g" "$APP/deploy/claude-settings.template.json" > "$settings" \
  || { echo "lan-claude: cannot write $settings"; exit 2; }

export LAN_CLAUDE_JOB="$job"
"$CLAUDE" "${model_args[@]}" \
  --settings "$settings" \
  -n "HP $job" "$prompt"
rc=$?
printf '{"exit":%d}\n' "$rc" > "$dir/exit.json"
echo
read -r -p "Sesi Claude dari HP selesai (exit $rc). Tekan Enter untuk menutup window ini. " _
