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
# http (or any other scheme, ftp included) is refused. Without curl, wget is run with --max-redirect=0
# and this script follows the redirects itself, at most 5, each only to an https:// URL or a relative
# path on the same origin. A file:// base is accepted too, for a local mirror, and it needs curl.
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
  --ref <tag>   release tag to install, for example v1.2.3 or v1.2.3-rc.1, at most 100 characters
                (required); branches, SHAs and anything else are refused
  --dest <dir>  where to extract, not empty; the release goes to <dir>/<tag> (default: $VIVERA_HOME, or
                ${XDG_DATA_HOME:-$HOME/.local/share}/vivera)
  --            everything after it is passed to the extracted install.sh
  -h, --help    print this text
Environment: VIVERA_BASE_URL (release download base; https://, or file:// for a local mirror, which
             needs curl), VIVERA_HOME (default destination)
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

# resolve_https <current-url> <location>: prints the absolute URL a redirect points to, or returns 1 when
# it is anything but https. A Location with a scheme must be https://; one without (//host/x, /x, x)
# keeps the scheme and host of the URL it was answered from.
resolve_https() {
  local rest="${1#https://}" authority path scheme_re='^[A-Za-z][A-Za-z0-9+.-]*:'
  authority="${rest%%[/?#]*}"
  case "$2" in
    # The scheme is written back in lower case: the next relative redirect strips "https://" from this URL.
    [Hh][Tt][Tt][Pp][Ss]://*) printf 'https://%s\n' "${2#*://}" ;;
    //*) printf 'https:%s\n' "$2" ;;
    /*) printf 'https://%s%s\n' "$authority" "$2" ;;
    *)
      # A scheme such as http:, ftp:, file: (or https: without //) is refused; a path may hold a colon
      # only after its first slash, so the pattern stops at the first / ? or #.
      if [[ "$2" =~ $scheme_re ]]; then
        return 1
      fi
      path="${rest#"$authority"}"
      path="${path%%[?#]*}"
      printf 'https://%s%s/%s\n' "$authority" "${path%/*}" "$2"
      ;;
  esac
}

# wget cannot be told to refuse a redirect to another scheme: --https-only limits only the links followed
# in recursive mode (probed with wget 1.25.0: it still fetched a plain-http URL, followed an https-to-http
# redirect, and followed an https-to-ftp redirect with anonymous FTP connects). So wget is run with
# --max-redirect=0, which hands every redirect back here with its Location in the -S headers, and this
# loop follows it, at most 5 times, only to a URL resolve_https accepts. Nothing is requested from a
# refused target, and the file is thrown away.
fetch_wget_https() {
  local url="$1" out="$2" log="$WORK/wget.log" hops=0 got http loc
  while :; do
    got=0
    wget -qS --max-redirect=0 -O "$out" "$url" 2>"$log" || got=$?
    http="$(sed -n 's|^[[:space:]]*HTTP/[0-9.]*[[:space:]][[:space:]]*\([0-9][0-9]*\).*|\1|p' "$log" | tail -n 1)"
    case "$http" in
      301 | 302 | 303 | 307 | 308) ;;
      *)
        [ "$got" -eq 0 ] && return 0
        rm -f -- "$out"
        return 1
        ;;
    esac
    loc="$(grep -i '^[[:space:]]*location:' "$log" | tail -n 1 | sed 's/^[^:]*:[[:space:]]*//; s/[[:space:]]*$//')"
    if [ -z "$loc" ]; then
      rm -f -- "$out"
      return 1
    fi
    if [ "$hops" -ge 5 ]; then
      rm -f -- "$out"
      echo "bootstrap.sh: too many redirects (more than 5) while downloading $1" >&2
      return 1
    fi
    if ! url="$(resolve_https "$url" "$loc")"; then
      rm -f -- "$out"
      echo "bootstrap.sh: refusing a redirect to a ${loc%%:*}: URL while downloading $1 (only https is followed)" >&2
      return 1
    fi
    hops=$((hops + 1))
  done
}

# fetch <url> <file>: curl is preferred, wget is the fallback. A network URL is https for the first
# request and for every redirect. A file:// URL gets there only through a file:// base, which main
# accepts (the tests serve a release that way) when curl is there to read it.
fetch() {
  case "$1" in
    file://*)
      curl --proto '=file' -fsSL -o "$2" "$1"
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
  local tag_re='^v[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.]+)?$' tag_max=100
  # The same cap as build-archive.sh: the file names made from the tag stay far under 255 bytes.
  [ "${#1}" -le "$tag_max" ] || return 1
  case "$1" in
    *..* | *. | *.lock) return 1 ;;
  esac
  (
    LC_ALL=C
    [[ "$1" =~ $tag_re ]]
  )
}

# discard_extraction <target> <existed>: the directory was absent or empty before this run, so what is in
# it now is only this extraction. One this run created goes; an empty one the user made stays, emptied again.
discard_extraction() {
  if [ "$2" = true ]; then
    find "$1" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
  else
    rm -rf -- "$1"
  fi
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
        [ -n "$2" ] || bad_usage "--dest needs a value that is not empty"
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
    bad_usage "--ref must be a release tag like v1.2.3, at most 100 characters (got \"$ref\"); branches and SHAs are not accepted"
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
  # wget cannot read file://, so say so now instead of failing the download with a generic message.
  case "$base" in
    file://*) command -v curl >/dev/null 2>&1 || fail "VIVERA_BASE_URL is a file:// URL and file:// needs curl (wget cannot read it)" ;;
  esac
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
    discard_extraction "$target" "$target_existed"
    fail "could not extract $archive"
  fi
  if [ ! -f "$target/install.sh" ]; then
    discard_extraction "$target" "$target_existed"
    fail "$archive has no install.sh at its top level"
  fi

  echo "==> Vivera $ref extracted to $target"
  local status=0
  bash "$target/install.sh" "$@" || status=$?
  exit "$status"
}

main "$@"
