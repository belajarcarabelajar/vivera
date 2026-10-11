#!/usr/bin/env bash
# scripts/release/build-archive.sh <tag> <outdir> [<ref>]
#
# Writes <outdir>/vivera-<tag>.tar.gz (a `git archive` of <ref>, default HEAD,
# under the prefix vivera-<tag>/) and <outdir>/vivera-<tag>.tar.gz.sha256 in
# sha256sum format. Prints both paths.
#
# Exit 0 on success, 1 on any git or hashing failure, 2 on a bad argument.
# Neither file is left behind unless the whole build succeeded.
#
# Reproducible: git stamps every entry with the commit time and `gzip -n`
# drops the name and timestamp from the gzip header, so the same commit gives
# the same bytes. tar.umask is pinned because a user-level setting would change
# the stored file modes.
#
# VIVERA_REPO_DIR overrides the repository to archive (default: two levels
# above this script).
set -euo pipefail

usage() {
  echo "Usage: build-archive.sh <tag> <outdir> [<ref>]   (tag looks like v1.2.3 or v1.2.3-rc.1)" >&2
}

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  usage
  exit 2
fi

tag="$1"
outdir="$2"
ref="${3:-HEAD}"

tag_re='^v[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.]+)?$'
if ! [[ "$tag" =~ $tag_re ]] || [ -z "$outdir" ]; then
  usage
  exit 2
fi
# A ref that starts with a dash would be read by git as an option.
case "$ref" in
  -*) usage; exit 2 ;;
esac

repo="${VIVERA_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
archive="vivera-$tag.tar.gz"

# Prints only the hex digest. sha256sum is missing on stock macOS, shasum is not.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

mkdir -p "$outdir"
tmp_archive="$outdir/.$archive.partial.$$"
tmp_sum="$outdir/.$archive.sha256.partial.$$"
trap 'rm -f -- "$tmp_archive" "$tmp_sum"' EXIT

git -C "$repo" -c tar.umask=0002 archive --format=tar --prefix="vivera-$tag/" "$ref" | gzip -n > "$tmp_archive"
digest="$(sha256_of "$tmp_archive")"
[ -n "$digest" ] || { echo "build-archive.sh: could not compute the SHA-256 of $archive" >&2; exit 1; }
printf '%s  %s\n' "$digest" "$archive" > "$tmp_sum"

mv -- "$tmp_archive" "$outdir/$archive"
mv -- "$tmp_sum" "$outdir/$archive.sha256"

echo "$outdir/$archive"
echo "$outdir/$archive.sha256"
