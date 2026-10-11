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
# What is and is not reproducible: git stamps every entry with the commit time,
# and tar.umask is pinned because a user-level setting (or the umask) would
# change the stored file modes, so the tar stream does not depend on the clock
# or on the builder's git config. The compressed bytes are only as stable as the
# gzip that runs: another gzip implementation or level gives a different hash,
# so compare hashes only between builds that share it. `gzip -n` drops the file
# name and timestamp from the gzip header, which only matters when gzip reads a
# file; here it reads a pipe and stores neither anyway, so `-n` is a guard.
#
# The .sha256 detects a damaged or swapped archive. It is not an attestation:
# it says nothing about who built the archive or from which commit.
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
# The match runs under LC_ALL=C because in a UTF-8 locale a range such as A-Z can
# admit letters outside ASCII. The pattern also accepts names git refuses
# (v1.0.0.., v1.0.0.lock, a trailing dot), so the tag must be a valid ref name too.
is_release_tag() {
  (
    LC_ALL=C
    [[ "$1" =~ $tag_re ]]
  ) && git check-ref-format "refs/tags/$1"
}
if ! is_release_tag "$tag" || [ -z "$outdir" ]; then
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

# Without either tool the shell would exit 127 from deep inside the command substitution below.
if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
  echo "build-archive.sh: need sha256sum or shasum to write the checksum" >&2
  exit 1
fi

mkdir -p "$outdir"
tmp_archive="$outdir/.$archive.partial.$$"
tmp_sum="$outdir/.$archive.sha256.partial.$$"
trap 'rm -f -- "$tmp_archive" "$tmp_sum"' EXIT

# Tested as a condition so a failing git (128 for a bad ref or a non-repository) or gzip is reported
# as this script's own exit 1, as the header says, instead of the raw status of the pipeline.
if ! git -C "$repo" -c tar.umask=0002 archive --format=tar --prefix="vivera-$tag/" "$ref" | gzip -n > "$tmp_archive"; then
  echo "build-archive.sh: could not archive $ref of $repo" >&2
  exit 1
fi
digest="$(sha256_of "$tmp_archive")"
[ -n "$digest" ] || { echo "build-archive.sh: could not compute the SHA-256 of $archive" >&2; exit 1; }
printf '%s  %s\n' "$digest" "$archive" > "$tmp_sum"

mv -- "$tmp_archive" "$outdir/$archive"
mv -- "$tmp_sum" "$outdir/$archive.sha256"

echo "$outdir/$archive"
echo "$outdir/$archive.sha256"
