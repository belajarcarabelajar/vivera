#!/usr/bin/env bash
# scripts/bootstrap.sh --ref <tag> [--dest <dir>] [--] [install.sh args...]
#
# Installs Vivera from a pinned release without a clone:
#   curl -fsSL <url>/bootstrap.sh | bash -s -- --ref v1.2.3 -- --tier standard
# It downloads vivera-<tag>.tar.gz and vivera-<tag>.tar.gz.sha256 from the release, checks the
# SHA-256, extracts into <dest>/<tag>/ and runs the extracted install.sh with the arguments after --.
#
# What the checksum proves: it is served from the same release origin as the archive, so it detects
# a corrupted download or a swapped archive, but not a compromised release (someone who can replace
# the archive can replace the checksum). Only release tags are accepted, never a branch or a SHA.
# The .sha256 must name the archive and carry the digest the archive really has.
#
# TLS is therefore the only integrity root, so the network is reached over https only: the base URL must
# start with https://, curl is told --proto '=https' --proto-redir '=https', and a redirect to plain
# http is refused. A file:// base is accepted too, for a local mirror.
#
# Environment: VIVERA_BASE_URL (default https://github.com/belajarcarabelajar/vivera/releases/download),
# VIVERA_HOME (destination when --dest is not given; default ${XDG_DATA_HOME:-$HOME/.local/share}/vivera).
# Exit: 0 success, 1 failure (download, checksum, tools, existing directory), 2 usage, else install.sh's status.
#
# Everything runs inside main, called on the last line, so nothing executes from a truncated download.
# The shell may exit 0 having done nothing (cutting at each line boundary gave a syntax error for most
# cuts and a silent exit 0 for the rest), so check that the "==> Vivera ... extracted" line appeared.
# No BASH_SOURCE, no associative arrays and no mapfile, so it runs from a pipe and on bash 3.2.
set -euo pipefail

WORK=""

cleanup() {
  if [ -n "$WORK" ]; then
    rm -rf -- "$WORK"
  fi
}
trap cleanup EXIT
# The EXIT trap does the cleaning; these make an interrupt reach it.
trap 'exit 130' INT
trap 'exit 143' TERM

usage() {
  cat <<'EOF'
Usage: bootstrap.sh --ref <tag> [--dest <dir>] [--] [install.sh args...]
  --ref <tag>   release tag to install, for example v1.2.3 or v1.2.3-rc.1 (required)
                branches, SHAs and anything else are refused
  --dest <dir>  where to extract; the release goes to <dir>/<tag> (default: $VIVERA_HOME, or
                ${XDG_DATA_HOME:-$HOME/.local/share}/vivera)
  --            everything after it is passed to the extracted install.sh
  -h, --help    print this text
Environment: VIVERA_BASE_URL (release download base; https://, or file:// for a local mirror),
             VIVERA_HOME (default destination)
Needs curl or wget, tar, and sha256sum or shasum.
EOF
}

# A usage error: say what is wrong, print the usage, exit 2. Nothing has been fetched or written yet.
bad_usage() {
  echo "bootstrap.sh: $1" >&2
  usage >&2
  exit 2
}

fail() {
  echo "[FAIL] $1" >&2
  exit 1
}

# wget cannot be told to refuse a redirect to plain http: --https-only limits only the links followed
# in recursive mode (probed with wget 1.25.0, it still fetched a plain-http URL and followed an
# https-to-http redirect). So the response headers are read after the download, and a Location that
# starts with http:// throws the file away before anything uses it.
fetch_wget_https() {
  local log="$WORK/wget.log"
  wget -qS -O "$2" "$1" 2>"$log" || return 1
  if grep -qi '^[[:space:]]*location:[[:space:]]*http://' "$log"; then
    rm -f -- "$2"
    echo "bootstrap.sh: refusing a redirect to plain http while downloading $1" >&2
    return 1
  fi
}

# fetch <url> <file>: curl is preferred, wget is the fallback. A network URL is https for the first
# request and for every redirect. A file:// URL gets there only through a file:// base, which main
# accepts (the tests serve a release that way); wget cannot read file:// itself.
fetch() {
  case "$1" in
    file://*)
      if command -v curl >/dev/null 2>&1; then
        curl --proto '=file' -fsSL -o "$2" "$1"
      else
        wget -qO "$2" "$1"
      fi
      ;;
    *)
      if command -v curl >/dev/null 2>&1; then
        curl --proto '=https' --proto-redir '=https' -fsSL -o "$2" "$1"
      else
        fetch_wget_https "$1" "$2"
      fi
      ;;
  esac
}

# digest_of <file>: the SHA-256 of the file, in lower-case hex.
digest_of() {
  local out
  if command -v sha256sum >/dev/null 2>&1; then
    out="$(sha256sum "$1")" || return 1
  else
    out="$(shasum -a 256 "$1")" || return 1
  fi
  printf '%s\n' "${out%% *}"
}

# verify <archive>, run in the directory holding it and <archive>.sha256. The checksum file must name
# this archive and carry the digest the archive really has: `sha256sum -c` alone also passes a file
# that names something else (the digest of /dev/null, say), which proves nothing about the archive.
verify() {
  local want="" name="" have
  read -r want name <"$1.sha256" || true
  name="${name#\*}"
  [ "$name" = "$1" ] || return 1
  have="$(digest_of "$1")" || return 1
  [ "$(printf '%s' "$want" | LC_ALL=C tr 'A-F' 'a-f')" = "$have" ]
}

# The same rule as scripts/release/build-archive.sh: the regex runs under LC_ALL=C because a UTF-8
# locale can widen a range such as A-Z, and the names git refuses are turned away too. build-archive.sh
# asks `git check-ref-format`; here git is not required (tier minimal has none), and for the
# characters the regex allows, those rules come down to the three patterns below.
is_release_tag() {
  local tag_re='^v[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.]+)?$'
  case "$1" in
    *..* | *. | *.lock) return 1 ;;
  esac
  (
    LC_ALL=C
    [[ "$1" =~ $tag_re ]]
  )
}

main() {
  local ref="" dest="" have_ref=false

  while [ $# -gt 0 ]; do
    case "$1" in
      --ref)
        [ $# -ge 2 ] || bad_usage "--ref needs a value"
        ref="$2"
        have_ref=true
        shift 2
        ;;
      --dest)
        [ $# -ge 2 ] || bad_usage "--dest needs a value"
        dest="$2"
        shift 2
        ;;
      --)
        shift
        break
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        bad_usage "unknown option: $1 (arguments for install.sh go after --)"
        ;;
    esac
  done
  # What is left in "$@" is for install.sh.

  [ "$have_ref" = true ] || bad_usage "--ref is required"
  if ! is_release_tag "$ref"; then
    bad_usage "--ref must be a release tag like v1.2.3 (got \"$ref\"); branches and SHAs are not accepted"
  fi

  local base="${VIVERA_BASE_URL:-https://github.com/belajarcarabelajar/vivera/releases/download}"
  base="${base%/}"
  case "$base" in
    https://* | file://*) ;;
    *) bad_usage "VIVERA_BASE_URL must start with https:// (got \"$base\"); a plain-http base is refused because TLS is the only thing that vouches for the download" ;;
  esac

  if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
    fail "need curl or wget to download the release"
  fi
  command -v tar >/dev/null 2>&1 || fail "need tar to extract the release"
  if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
    fail "need sha256sum or shasum to verify the release"
  fi

  if [ -z "$dest" ]; then
    dest="${VIVERA_HOME:-${XDG_DATA_HOME:-${HOME:?HOME is not set}/.local/share}/vivera}"
  fi
  # The installed links point into this directory, so a relative path would break with the next cd.
  case "$dest" in
    /*) ;;
    *) dest="$PWD/$dest" ;;
  esac
  local target="$dest/$ref" target_existed=false
  if [ -e "$target" ] || [ -L "$target" ]; then
    if [ ! -d "$target" ] || [ -L "$target" ] || [ -n "$(ls -A "$target")" ]; then
      if [ -d "$target" ] && [ ! -L "$target" ] && [ -f "$target/install.sh" ]; then
        local resume arg
        resume="cd $(printf '%q' "$target") && ./install.sh"
        for arg in "$@"; do
          resume="$resume $(printf '%q' "$arg")"
        done
        fail "$target already exists. If an earlier run stopped part way, resume it with: $resume (otherwise remove it or pick another --dest)"
      fi
      fail "$target already exists; remove it or pick another --dest"
    fi
    # An empty directory the user made: this run fills it, and leaves it in place if extraction fails.
    target_existed=true
  fi

  local archive="vivera-$ref.tar.gz"
  WORK="$(mktemp -d)"

  # Nothing leaves the work directory until the checksum has passed.
  fetch "$base/$ref/$archive" "$WORK/$archive" || fail "could not download $base/$ref/$archive"
  fetch "$base/$ref/$archive.sha256" "$WORK/$archive.sha256" || fail "could not download $base/$ref/$archive.sha256"
  if ! (cd "$WORK" && verify "$archive" >/dev/null 2>&1); then
    fail "$archive.sha256 does not name $archive with its SHA-256; nothing was extracted"
  fi

  mkdir -p "$target"
  if ! tar -xzf "$WORK/$archive" -C "$target" --strip-components=1; then
    # The directory was absent or empty before, so what is in it now is only this extraction. One
    # this run created goes; an empty one the user made stays, emptied again.
    if [ "$target_existed" = true ]; then
      find "$target" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
    else
      rm -rf -- "$target"
    fi
    fail "could not extract $archive"
  fi
  [ -f "$target/install.sh" ] || fail "$archive has no install.sh at its top level"

  echo "==> Vivera $ref extracted to $target"
  local status=0
  bash "$target/install.sh" "$@" || status=$?
  exit "$status"
}

main "$@"
