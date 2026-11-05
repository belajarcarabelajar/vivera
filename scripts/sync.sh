#!/usr/bin/env bash
# scripts/sync.sh — Bidirectional sync helper between repository and ~/.config/ai/
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="$HOME/.config/ai"
FILE_NAME="Super Ultra Code Plan Implementation.md"

ACTION="${1:-status}"
FORCE="${2:-}"
SRC="$REPO_DIR/$FILE_NAME"
DEST="$CONFIG_DIR/$FILE_NAME"

is_linked() {
  [ -L "$DEST" ] && [ "$(readlink -f "$DEST")" = "$(readlink -f "$SRC")" ]
}

# A regular file that differs from the repo may hold the user's own edits, and
# push or link would destroy them without a trace.
refuse_local_edits() {
  if [ "$FORCE" != "--force" ] && [ -f "$DEST" ] && [ ! -L "$DEST" ] && ! cmp -s "$SRC" "$DEST"; then
    echo "[ERROR] $DEST differs from the repo version and may hold local edits." >&2
    echo "        Run '$0 pull' to keep them, or '$0 $ACTION --force' to replace them." >&2
    exit 1
  fi
}

case "$ACTION" in
  status)
    echo "==> Comparing $REPO_DIR/$FILE_NAME with $CONFIG_DIR/$FILE_NAME..."
    if [ -L "$CONFIG_DIR/$FILE_NAME" ]; then
      echo "[INFO] $CONFIG_DIR/$FILE_NAME is a symlink pointing to $(readlink -f "$CONFIG_DIR/$FILE_NAME")"
    elif [ -f "$CONFIG_DIR/$FILE_NAME" ]; then
      diff -u "$REPO_DIR/$FILE_NAME" "$CONFIG_DIR/$FILE_NAME" || true
    else
      echo "[WARN] $CONFIG_DIR/$FILE_NAME does not exist."
    fi
    ;;
  push)
    echo "==> Pushing repo version to $CONFIG_DIR..."
    if is_linked; then
      echo "[OK] $DEST is already linked to the repo version. Nothing to copy."
      exit 0
    fi
    refuse_local_edits
    mkdir -p "$CONFIG_DIR"
    cp "$SRC" "$DEST"
    echo "[OK] Copied $FILE_NAME to $CONFIG_DIR"
    ;;
  pull)
    echo "==> Pulling changes from $CONFIG_DIR to repo..."
    if [ -f "$CONFIG_DIR/$FILE_NAME" ] && [ ! -L "$CONFIG_DIR/$FILE_NAME" ]; then
      cp "$CONFIG_DIR/$FILE_NAME" "$REPO_DIR/$FILE_NAME"
      echo "[OK] Updated repo from $CONFIG_DIR"
    else
      echo "[INFO] $CONFIG_DIR/$FILE_NAME is a symlink or missing. No pull needed."
    fi
    ;;
  link)
    echo "==> Symlinking repo version into $CONFIG_DIR..."
    refuse_local_edits
    mkdir -p "$CONFIG_DIR"
    ln -sf "$REPO_DIR/$FILE_NAME" "$CONFIG_DIR/$FILE_NAME"
    echo "[OK] Symlink established."
    ;;
  *)
    echo "Usage: $0 [status|push|pull|link] [--force]"
    exit 1
    ;;
esac
