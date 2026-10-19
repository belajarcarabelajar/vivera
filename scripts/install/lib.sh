# shellcheck shell=bash
# Sourced by install.sh: tool probing, and how a destination is judged (classify_dest) and named.
# Placing links and copies is in place.sh. The directory helpers behind the digests are in digest.sh.

# shellcheck source=digest.sh
. "$REPO_DIR/scripts/install/digest.sh"

tool_available() {
  # Single source of truth for "can we call $cmd". Beyond the current PATH it
  # probes the two standard fallback dirs and, when found there, APPENDS that
  # dir to PATH so every later `$cmd` invocation works. Appended, never prepended:
  # a same-named wrapper of the user's there (cp, mv, rm) must not shadow the system
  # tool. Optional-tool warnings fire only when all three probes fail.
  local cmd="$1"
  if command -v "$cmd" &>/dev/null; then
    return 0
  fi
  if [ -x "$HOME/.local/bin/$cmd" ]; then
    export PATH="$PATH:$HOME/.local/bin"
    return 0
  fi
  if [ -x "$HOME/.bun/bin/$cmd" ]; then
    export PATH="$PATH:$HOME/.bun/bin"
    return 0
  fi
  return 1
}

# A required tool: found, then asked for its version on a closed stdin. A tool that fails or prints
# nothing on --version still counts as found, so a failure cannot abort the run under pipefail.
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
  version="$("$cmd" --version </dev/null 2>&1 | head -n 1 || true)"
  # On macOS /usr/bin/git is a stub that only offers to install the developer tools; it is not git.
  if [ "$cmd" = "git" ]; then
    case "$version" in
      "xcode-select:"*)
        echo "❌ Missing prerequisite: 'git' ($label) is mandatory; the one found is the macOS developer-tools stub." >&2
        echo "   Hint: xcode-select --install, or install git another way." >&2
        exit 1
        ;;
    esac
  fi
  [ -z "$version" ] && version="installed (no version flag)"
  echo "[OK] Prerequisite verified: $cmd — $version"
}

# Optional tool: warn once with the lost capability named, then move on. A tool that is present is
# only reported as found: it is never run, because an optional tool owes this installer nothing.
# The third argument "true" keeps a missing tool silent, for a run that does not need the tool at all.
check_optional() {
  local cmd="$1"
  local loss="$2"
  local quiet="${3:-false}"

  if ! tool_available "$cmd"; then
    if [ "$quiet" != true ]; then
      echo "⚠️  WARNING: optional tool '$cmd' not found; $loss" >&2
    fi
    return 0
  fi
  echo "[OK] Optional tool found: $cmd"
}

# Absolute path whose directory part is physical (symlinks resolved) and whose last component is
# left alone. No readlink -f or realpath: macOS does not ship them.
abs_path() {
  local path="$1"
  local dir
  if dir="$(cd -P "$(dirname "$path")" 2>/dev/null && pwd -P)"; then
    if [ "$dir" = "/" ]; then
      echo "/$(basename "$path")"
    else
      echo "$dir/$(basename "$path")"
    fi
  else
    echo "$path"
  fi
}

# mkdir -p that fails with an installer line instead of coreutils' own. That message names the first
# component it could not create ("mkdir: cannot create directory '/x/.config': Permission denied") and
# starts with no installer prefix, so only its reason (after the last ": ") is kept. Every directory
# the installer makes is under HOME, so the hint names it, but only for a permission problem.
make_dir() {
  local dir="$1"
  local err reason
  if err="$(mkdir -p "$dir" 2>&1)"; then
    return 0
  fi
  reason="${err##*: }"
  if [ -z "$reason" ]; then
    reason="mkdir failed"
  fi
  case "$reason" in
    *"Permission denied"* | *"Read-only file system"*) reason="$reason (is HOME writable?)" ;;
  esac
  echo "[FAIL] cannot create $dir: $reason" >&2
  exit 1
}

# Copy mode compares content with cmp (files) and diff (directories).
copy_tools_present() {
  command -v cmp >/dev/null 2>&1 && command -v diff >/dev/null 2>&1
}

require_copy_tools() {
  local tool
  for tool in cmp diff; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      echo "❌ Missing prerequisite: '$tool' (copy mode compares file content) is mandatory." >&2
      exit 1
    fi
  done
}

# A marker is "regular" when it is a plain file and not a symlink: nothing else is ever opened or read
# (a FIFO would hang the installer), and a link could point at any file of the user's.
marker_regular() {
  [ -f "$1" ] && [ ! -L "$1" ]
}

# True when <dest> is a copy the installer made: its directory holds a .vivera-managed marker (a
# package entry) or it has a <dest>.vivera-managed sidecar (a lone file such as the ai-config one).
copy_managed() {
  local dest="$1"
  marker_regular "$(dirname "$dest")/.vivera-managed" || marker_regular "$dest.vivera-managed"
}

# True when the copy at <dest> has the same content as <src>: cmp for a file, diff -rq for a directory
# (dirs_equal in digest.sh). Trouble of any kind (a missing tool, an unreadable file, diff exiting 2) is
# "not equal". This is the one judgement of "identical": a digest never overrides it.
content_equal() {
  local src="$1"
  local dest="$2"
  copy_tools_present || return 1
  if [ -d "$src" ]; then
    [ -d "$dest" ] && [ ! -L "$dest" ] && dirs_equal "$src" "$dest"
  else
    [ -f "$dest" ] && [ ! -L "$dest" ] && cmp -s "$src" "$dest"
  fi
}

# --- Digests ---------------------------------------------------------------------------------
# A managed copy that differs from its source is either outdated (the checkout moved on) or edited by
# the user. The marker keeps, per entry, the digest of what the installer last placed: a copy that still
# has that digest is "pristine" and may be refreshed or removed; any other difference is "modified" and
# is never discarded. The digest names its algorithm, so a record is only compared with the same one.
# A digest FAILS CLOSED: entry_digest prints nothing when it cannot vouch for what it was asked about (no
# working hash tool, an unreadable entry, a FIFO), and nothing can match an empty digest.
HASH_ALGO=""
HASH_CMD=()
HASH_READY=false

# True when the hash command "$@" works: it exists, exits 0 on empty input and prints a first field of
# the shape <algo> gives. A tool that is on PATH but cannot run (a shasum without perl) does not count.
hash_probe() {
  local algo="$1"
  local out
  shift
  command -v "$1" >/dev/null 2>&1 || return 1
  out="$("$@" </dev/null 2>/dev/null)" || return 1
  out="${out%% *}"
  case "$algo" in
    sha256)
      case "$out" in
        "" | *[!0-9a-f]*) return 1 ;;
      esac
      [ "${#out}" -eq 64 ]
      ;;
    *)
      case "$out" in
        "" | *[!0-9]*) return 1 ;;
      esac
      ;;
  esac
}

# Picks the first hash tool that really works. With none, HASH_ALGO stays empty and every digest is empty.
hash_init() {
  if [ "$HASH_READY" = true ]; then
    return 0
  fi
  HASH_ALGO=""
  HASH_CMD=()
  if hash_probe sha256 sha256sum; then
    HASH_ALGO="sha256"
    HASH_CMD=(sha256sum)
  elif hash_probe sha256 shasum -a 256; then
    HASH_ALGO="sha256"
    HASH_CMD=(shasum -a 256)
  elif hash_probe cksum cksum; then
    HASH_ALGO="cksum"
    HASH_CMD=(cksum)
  fi
  HASH_READY=true
}

# Reads stdin, prints "<algo>:<digest>". Fails, printing nothing, when there is no working hash tool or
# the tool fails.
digest_stdin() {
  local out
  hash_init
  if [ -z "$HASH_ALGO" ]; then
    return 1
  fi
  out="$("${HASH_CMD[@]}")" || return 1
  if [ "$HASH_ALGO" = "cksum" ]; then
    out="${out// /-}"
  else
    out="${out%% *}"
  fi
  if [ -z "$out" ]; then
    return 1
  fi
  echo "$HASH_ALGO:$out"
}

# "<algo>:<digest>" of a file's bytes, or of a directory's listing (dir_listing in digest.sh: every
# directory, symlink and regular file in it, sorted, with a header line so that an empty directory is not
# the digest of an empty file). Prints nothing for anything else, and whenever it cannot vouch for all of
# it: no working hash tool, a command that fails, an unreadable entry, a FIFO, a name with a newline.
entry_digest() {
  local path="$1"
  local listing sorted
  hash_init
  if [ -z "$HASH_ALGO" ]; then
    return 0
  fi
  if [ -d "$path" ] && [ ! -L "$path" ]; then
    listing="$(dir_listing "$path")" || return 0
    sorted="$(printf 'vivera-dir\n%s\n' "$listing" | LC_ALL=C sort)" || return 0
    digest_stdin <<< "$sorted" || true
  elif [ -f "$path" ] && [ ! -L "$path" ]; then
    digest_stdin 2>/dev/null < "$path" || true
  fi
  return 0
}

# The digest the marker recorded for <dest> ("entry <name> <algo>:<digest>"), or nothing. A name that
# has more than one line (in the package marker and the sidecar together) is ambiguous: nothing is
# believed, so the copy is judged modified.
recorded_digest() {
  local dest="$1"
  local name marker line rest found count
  name="$(basename "$dest")"
  found=""
  count=0
  for marker in "$(dirname "$dest")/.vivera-managed" "$dest.vivera-managed"; do
    if marker_regular "$marker"; then
      while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
          "entry $name "*)
            count=$((count + 1))
            rest="${line#"entry $name "}"
            case "$rest" in
              *" "*) ;;
              *) found="$rest" ;;
            esac
            ;;
        esac
      done < "$marker"
    fi
  done
  if [ "$count" -eq 1 ] && [ -n "$found" ]; then
    echo "$found"
  fi
  return 0
}

# What a managed copy is, judged against its source: identical (cmp or diff says the content is the
# same), pristine (not the source's content, but exactly what the installer last placed, so merely
# outdated) or modified (anything else, which includes a copy with no record, an ambiguous or foreign
# record, and a copy that cannot be vouched for). The digest only ever decides pristine: it never
# overrides cmp or diff, because it could not see everything they see (and the other way round).
managed_state() {
  local src="$1"
  local dest="$2"
  local current recorded
  if content_equal "$src" "$dest"; then
    echo "identical"
    return 0
  fi
  current="$(entry_digest "$dest")"
  recorded="$(recorded_digest "$dest")"
  if [ -n "$current" ] && [ "$current" = "$recorded" ]; then
    echo "pristine"
  else
    echo "modified"
  fi
}

# True when <dest> is a file of this checkout itself: its directory, with every symlink resolved, is
# the repo or lies under it. That happens when a harness dir is a symlink into the repo (for example
# ~/.claude/skills/sucp-rules -> <repo>/skills/sucp-rules), and then the "destination" is the source.
# A directory that does not exist is not inside anything.
dest_in_repo() {
  local dest="$1"
  local dir repo_phys
  dir="$(cd -P "$(dirname "$dest")" 2>/dev/null && pwd -P)" || return 1
  repo_phys="$(cd -P "$REPO_DIR" && pwd -P)"
  case "$dir" in
    "$repo_phys" | "$repo_phys"/*) return 0 ;;
  esac
  return 1
}

# True when <dest> is under $HOME and some directory between $HOME and <dest> is a symlink, so that
# <dest> physically lives somewhere else: another checkout, or the user's dotfiles. A symlink at or
# above $HOME does not count (a temp dir or a home on another mount is often reached through one).
# The test compares the physical directory of <dest> with the physical $HOME plus the same relative
# path: they differ exactly when a symlink sits in between. A directory that does not exist is not
# behind anything.
behind_symlinked_dir() {
  local dest="$1"
  local dir rel phys_dir phys_home
  case "$dest" in
    "$HOME"/*) ;;
    *) return 1 ;;
  esac
  dir="$(dirname "$dest")"
  rel="${dir#"$HOME"}"
  phys_dir="$(cd -P "$dir" 2>/dev/null && pwd -P)" || return 1
  phys_home="$(cd -P "$HOME" && pwd -P)"
  [ "$phys_dir" != "$phys_home$rel" ]
}

# behind_symlinked_dir for a <dest> whose directory may not exist yet: the nearest directory that does
# exist decides, because whatever is created below a symlinked directory lands in the other tree.
behind_symlinked_ancestor() {
  local dir
  dir="$(dirname "$1")"
  while [ ! -d "$dir" ]; do
    dir="$(dirname "$dir")"
  done
  behind_symlinked_dir "$dir/x"
}

# The state of a symlink at <dest>: ok when it already resolves to <desired>; ours-stale when it
# resolves inside this repo (live or dangling) or is a legacy link of the old ai-skills repo (the
# installer made it, so it is replaced without a backup); foreign for any other link, including one
# that dangles somewhere else (an unmounted drive): that is moved aside, never silently replaced.
classify_link() {
  local dest="$1"
  local desired="$2"
  local target resolved abs_desired repo_phys

  target="$(readlink "$dest")"
  case "$target" in
    /*) resolved="$target" ;;
    *) resolved="$(dirname "$dest")/$target" ;;
  esac
  resolved="$(abs_path "$resolved")"
  abs_desired="$(abs_path "$desired")"
  if [ "$target" = "$desired" ] || [ "$resolved" = "$abs_desired" ]; then
    echo "ok"
    return 0
  fi
  repo_phys="$(cd -P "$REPO_DIR" && pwd -P)"
  case "$resolved" in
    "$REPO_DIR"/* | "$repo_phys"/*)
      echo "ours-stale"
      return 0
      ;;
  esac
  # The items the old ai-skills repo linked, and nothing else under that name.
  case "$target" in
    */ai-skills/"Super Ultra Code Plan Implementation.md" | */ai-skills/skills/* | */ai-skills/templates | */ai-skills/examples | */ai-skills/mermaid.config.json | */ai-skills/mermaid.dark.config.json)
      echo "ours-stale"
      return 0
      ;;
  esac
  case "$resolved" in
    */ai-skills/"Super Ultra Code Plan Implementation.md" | */ai-skills/skills/* | */ai-skills/templates | */ai-skills/examples | */ai-skills/mermaid.config.json | */ai-skills/mermaid.dark.config.json)
      echo "ours-stale"
      return 0
      ;;
  esac
  echo "foreign"
}

# Prints exactly one of: absent, ok, ours-stale, foreign, inrepo, viadir.
#   inrepo     <dest> is a file of this checkout itself (see dest_in_repo); it is never touched
#   viadir     <dest> lives behind a symlinked directory (see behind_symlinked_dir), so it belongs to
#              another tree (another checkout, the user's dotfiles) and is never moved, removed or
#              retargeted. That is: an existing real file or directory; a link there that classify_link
#              calls foreign (live or dangling); in copy mode ANY link there, the installer's own
#              included, since a copy would replace it by a real file in the other tree; and, in copy
#              mode only, an absent dest, even when its directory is absent too (see
#              behind_symlinked_ancestor): a copy written there would be left alone for good by check,
#              update and uninstall, so the second run would refuse what the first one wrote. In link
#              mode an absent dest stays absent (the link is the installer's own, and check, update and
#              uninstall manage it), and an ok or ours-stale link there is judged as anywhere else
#   ok         what is wanted is there: a link to <desired>, or in copy mode a managed copy with the
#              same content as <desired>
#   ours-stale the installer's own and wrong: a link as classify_link says, or a managed copy that is
#              pristine (outdated but never edited, see managed_state), or in link mode a managed
#              copy that is identical to its source; replaced without a backup because nothing the
#              user wrote is lost
#   foreign    a real file or directory without a marker, a live link anywhere else, or a managed copy
#              that is modified (the user edited it, or nothing proves they did not): moved aside,
#              never discarded
classify_dest() {
  local dest="$1"
  local desired="$2"
  local state

  if dest_in_repo "$dest"; then
    echo "inrepo"
  elif [ ! -L "$dest" ] && [ -e "$dest" ] && behind_symlinked_dir "$dest"; then
    echo "viadir"
  elif [ -L "$dest" ]; then
    state="$(classify_link "$dest" "$desired")"
    # Behind a symlinked directory: any link in copy mode (a copy would be a real file in the other
    # tree), only a foreign one in link mode.
    if behind_symlinked_dir "$dest" && { [ "$state" = "foreign" ] || [ "${COPY_MODE:-false}" = true ]; }; then
      state="viadir"
    elif [ "$state" = "ok" ] && [ "${COPY_MODE:-false}" = true ]; then
      state="ours-stale"
    fi
    echo "$state"
  elif [ -e "$dest" ]; then
    if ! copy_managed "$dest"; then
      echo "foreign"
    else
      case "$(managed_state "$desired" "$dest")" in
        identical)
          if [ "${COPY_MODE:-false}" = true ]; then echo "ok"; else echo "ours-stale"; fi
          ;;
        pristine) echo "ours-stale" ;;
        *) echo "foreign" ;;
      esac
    fi
  elif [ "${COPY_MODE:-false}" = true ] && behind_symlinked_ancestor "$dest"; then
    echo "viadir"
  else
    echo "absent"
  fi
}

# <dest>.vivera-bak-<UTC stamp>, with -1, -2, ... appended until the name is free.
backup_path() {
  local dest="$1"
  local stamp="${VIVERA_NOW:-$(date -u +%Y%m%dT%H%M%SZ)}"
  local candidate="$dest.vivera-bak-$stamp"
  local n=1
  while [ -e "$candidate" ] || [ -L "$candidate" ]; do
    candidate="$dest.vivera-bak-$stamp-$n"
    n=$((n + 1))
  done
  echo "$candidate"
}

# The links one skill package makes in <skills dir>, one "<desired><TAB><dest>" line each, in the
# order they are placed. This is the only place that knows the list: install, check, update and
# uninstall all read it. Paths contain spaces but never a TAB or a newline.
package_entries() {
  local dir="$1"
  local sibling_dir phase_dir phase_name
  sibling_dir="$(dirname "$dir")"

  printf '%s\t%s\n' "$MASTER_FILE" "$dir/SKILL.md"
  # Phase skills are siblings of the orchestrator, so each harness discovers
  # them by name and the orchestrator can load them with the skill tool.
  for phase_dir in "$REPO_DIR"/skills/sucp-*; do
    phase_name="$(basename "$phase_dir")"
    printf '%s\t%s\n' "$phase_dir/SKILL.md" "$sibling_dir/$phase_name/SKILL.md"
    if [ -d "$phase_dir/references" ]; then
      printf '%s\t%s\n' "$phase_dir/references" "$sibling_dir/$phase_name/references"
    fi
  done
  printf '%s\t%s\n' "$REPO_DIR/templates" "$dir/templates"
  printf '%s\t%s\n' "$REPO_DIR/examples" "$dir/examples"
  # Theming config ships with the skill so an installed harness can reproduce
  # the same diagram rendering (font embedding, palette, dark variant).
  printf '%s\t%s\n' "$REPO_DIR/mermaid.config.json" "$dir/mermaid.config.json"
  printf '%s\t%s\n' "$REPO_DIR/mermaid.dark.config.json" "$dir/mermaid.dark.config.json"
  # The Stop hook in the orchestrator's frontmatter runs this script from the installed package.
  printf '%s\t%s\n' "$REPO_DIR/.claude/hooks/require-exit-code.mjs" "$dir/require-exit-code.mjs"
}
