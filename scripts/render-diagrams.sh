#!/usr/bin/env bash
# scripts/render-diagrams.sh
#
# Renders every ```mermaid block in the repository to SVG under diagrams/.
#
# Contract:
#   * Symlinked files are skipped. skills/*/SKILL.md points at the master file,
#     so scanning them would emit a byte-identical duplicate of every diagram.
#   * The committed hero (README lifecycle) is rendered twice, light and dark,
#     so the README can serve it through <picture> + prefers-color-scheme.
#   * Orphaned SVGs from deleted diagrams are pruned; a stale artifact is worse
#     than no artifact.
#   * Zero blocks found is a failure, not a silent success.
#
# Theming lives in mermaid.config.json / mermaid.dark.config.json. Do not pass
# -t here; the config file is the single source of truth.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR="$REPO_DIR/diagrams"
TEMP_DIR="$REPO_DIR/.mermaid-tmp"
STAGE_DIR="$TEMP_DIR/stage"
LIGHT_CONFIG="$REPO_DIR/mermaid.config.json"
DARK_CONFIG="$REPO_DIR/mermaid.dark.config.json"

# Hero: the first mermaid block in the README, committed to the repo.
HERO_FILE="README.md"
HERO_BLOCK=1
HERO_NAME="lifecycle"

# ---- Resolve mmdc ----------------------------------------------------------
if [ -f "$REPO_DIR/node_modules/.bin/mmdc" ]; then
  MMDC="$REPO_DIR/node_modules/.bin/mmdc"
elif command -v mmdc &>/dev/null; then
  MMDC="mmdc"
else
  echo "❌ mmdc not found. Run: bun install" >&2
  exit 1
fi

for cfg in "$LIGHT_CONFIG" "$DARK_CONFIG" "$REPO_DIR/puppeteer-config.json"; do
  if [ ! -f "$cfg" ]; then
    echo "❌ Missing required config: ${cfg#$REPO_DIR/}" >&2
    exit 1
  fi
done

PUPPETEER_FLAG="-p $REPO_DIR/puppeteer-config.json"

rm -rf "$TEMP_DIR"
mkdir -p "$STAGE_DIR"

# ---- Extract blocks and render ---------------------------------------------
rendered=0
errors=0

# slugify <path> — stable, collision-free stem shared with the hero lookup below.
slugify() {
  printf '%s' "${1#"$REPO_DIR"/}" | sed 's|/|-|g; s|\.md$||; s|[^A-Za-z0-9_-]|-|g' | tr '[:upper:]' '[:lower:]'
}

extract_blocks() {
  local mdfile="$1" stem="$2" out_dir="${3:-$STAGE_DIR}"
  mkdir -p "$out_dir"
  awk -v stage="$out_dir" -v stem="$stem" '
    /^```mermaid[ \t]*$/ { inside=1; block++; buf=""; next }
    inside && /^```[ \t]*$/ {
      out = stage "/" stem "-block" block ".mmd";
      printf "%s", buf > out;
      close(out);
      inside=0; next
    }
    inside { buf = buf $0 "\n" }
  ' "$mdfile"
}

while IFS= read -r -d '' mdfile; do
  # The hero file is rendered separately (light + dark) under its canonical name,
  # so it is staged in its own directory and never picked up by the bulk loop.
  if [ "$mdfile" = "$REPO_DIR/$HERO_FILE" ]; then
    extract_blocks "$mdfile" "$(slugify "$mdfile")" "$STAGE_DIR/hero-src"
    continue
  fi
  extract_blocks "$mdfile" "$(slugify "$mdfile")" "$STAGE_DIR"
done < <(find "$REPO_DIR" -name "*.md" -type f \
  -not -path "*/node_modules/*" \
  -not -path "*/.git/*" \
  -not -path "*/diagrams/*" \
  -print0 | sort -z)

block_count=$(find "$STAGE_DIR" -name "*.mmd" -type f | wc -l | tr -d ' ')
if [ "$block_count" -eq 0 ]; then
  echo "❌ No mermaid blocks found. The extraction pattern no longer matches the markdown." >&2
  exit 1
fi

mapfile -t staged_mmds < <(find "$STAGE_DIR" -name "*.mmd" | sort)

# One mmdc call renders every block (one Chromium launch instead of one per
# block) and writes out-<n>.svg in order. A batch that fails cannot say which
# block broke, so it falls back to the per-block loop, which names it.
BATCH_DIR="$TEMP_DIR/batch"
mkdir -p "$BATCH_DIR"
for mmd in "${staged_mmds[@]}"; do
  printf '```mermaid\n'; cat "$mmd"; printf '```\n\n'
done > "$BATCH_DIR/all.md"
batch_ok=0
if "$MMDC" $PUPPETEER_FLAG -c "$LIGHT_CONFIG" -b transparent --quiet \
     --input "$BATCH_DIR/all.md" --output "$BATCH_DIR/out.md" 2>/dev/null; then
  batch_ok=1
  for i in "${!staged_mmds[@]}"; do
    [ -f "$BATCH_DIR/out-$((i + 1)).svg" ] || batch_ok=0
  done
fi

if [ "$batch_ok" -eq 1 ]; then
  for i in "${!staged_mmds[@]}"; do
    mv "$BATCH_DIR/out-$((i + 1)).svg" "${staged_mmds[$i]%.mmd}.svg"
  done
  rendered=$((rendered + ${#staged_mmds[@]}))
else
  for mmd in "${staged_mmds[@]}"; do
    svg="${mmd%.mmd}.svg"
    if "$MMDC" $PUPPETEER_FLAG -c "$LIGHT_CONFIG" -b transparent --quiet \
         --input "$mmd" --output "$svg"; then
      rendered=$((rendered + 1))
    else
      echo "  ❌ FAILED: ${mmd#$STAGE_DIR/}" >&2
      errors=$((errors + 1))
    fi
  done
fi

# ---- Hero: light + dark ----------------------------------------------------
hero_mmd="$STAGE_DIR/hero-src/$(slugify "$REPO_DIR/$HERO_FILE")-block${HERO_BLOCK}.mmd"
if [ ! -f "$hero_mmd" ]; then
  echo "  ❌ Hero block not found: $HERO_FILE block $HERO_BLOCK" >&2
  exit 1
fi
if ! "$MMDC" $PUPPETEER_FLAG -c "$LIGHT_CONFIG" -b transparent --quiet \
     --input "$hero_mmd" --output "$STAGE_DIR/$HERO_NAME.svg"; then
  echo "  ❌ FAILED: hero (light)" >&2
  exit 1
fi
if ! "$MMDC" $PUPPETEER_FLAG -c "$DARK_CONFIG" -b transparent --quiet \
     --input "$hero_mmd" --output "$STAGE_DIR/$HERO_NAME-dark.svg"; then
  echo "  ❌ FAILED: hero (dark)" >&2
  exit 1
fi
rendered=$((rendered + 2))

# ---- Publish: sync, pruning orphans ----------------------------------------
# mmdc output is nondeterministic: two renders of the same block differ in
# path coordinates while every text node stays identical (measured on this
# machine, same input, 319944 vs 319930 bytes with identical <p> sequences).
# A blind copy would therefore dirty the two committed heroes on every run,
# so a tracked file is only replaced when its text nodes changed. Untracked
# (gitignored) files are always written; they are throwaway build artifacts.
#
# Revert: restore the single `cp` line below and delete `svg_text` and the
# publish loop. `bun run ci` will dirty the heroes again, which is the
# symptom this exists to stop.
# One text node per line, sorted: node ORDER varies between renders as well,
# so neither byte equality nor a greedy single-span match can tell churn from
# a real edit. GNU grep -P is required (Arch ships it; the bare `grep -o` form
# above was measured to keep churning because its greedy span swallows the path
# data between the first and last node).
svg_text() { grep -oP '<p>.*?</p>' "$1" 2>/dev/null | sort || true; }
mkdir -p "$OUTPUT_DIR"
pruned=0
kept=0
updated=0
while IFS= read -r -d '' existing; do
  base="$(basename "$existing")"
  if [ ! -f "$STAGE_DIR/$base" ]; then
    rm -f "$existing"
    pruned=$((pruned + 1))
  fi
done < <(find "$OUTPUT_DIR" -maxdepth 1 -name "*.svg" -print0)

for staged in "$STAGE_DIR"/*.svg; do
  base="$(basename "$staged")"
  dest="$OUTPUT_DIR/$base"
  if [ -f "$dest" ] && ! git check-ignore -q "$dest" 2>/dev/null; then
    if [ "$(svg_text "$staged")" = "$(svg_text "$dest")" ]; then
      kept=$((kept + 1))
      continue
    fi
    updated=$((updated + 1))
  fi
  cp "$staged" "$dest"
done

rm -rf "$TEMP_DIR"

echo ""
echo "==> Blocks found: $block_count   Rendered: $rendered   Pruned orphans: $pruned   Committed updated: $updated   kept: $kept"
if [ "$errors" -gt 0 ]; then
  echo "❌ $errors rendering error(s). See failures above." >&2
  exit 1
fi
echo "✅ Diagrams rendered to diagrams/ (hero committed: $HERO_NAME.svg, $HERO_NAME-dark.svg)"
