# shellcheck shell=bash
# Sourced by lib.sh: the two directory helpers behind the digests (entry_digest, content_equal). A managed
# copy that differs from its source is either outdated or edited by the user, and these helpers must never
# let an edit look like "nothing": what they cannot see or cannot read is reported as a failure, and the
# callers read a failure as "modified" (the copy is moved aside or kept, never discarded).

# Prints one line per entry of the directory <dir>, in no particular order, and exits non-zero when it
# cannot vouch for the whole tree:
#   d <path>                    a directory (an empty one included)
#   l <path> <link target>      a symlink; the walk does not follow it, and the installed copy is made
#                               with cp -RL, so a symlink inside a copy was added by the user
#   f <hash> <path>            a regular file, <hash> being what digest_stdin says of its bytes
#   x <hash> <path>            the same for a file with the owner exec bit
# Paths are relative to <dir>. A file named .DS_Store is Finder litter and is left out BY DESIGN (a
# directory or a symlink of that name is not: only a plain file is litter). It fails, listing nothing
# that can be trusted, when a find, a readlink or a hash command fails (an unreadable file or directory
# among them), when the tree holds a type that cannot be vouched for (FIFO, socket, device) or a name
# with a newline (a line-based listing cannot tell it).
# Known limits: modification times and mode bits other than the owner exec bit are not part of it.
dir_listing() {
  local dir="$1"
  (
    cd -P "$dir" 2>/dev/null || exit 1
    LC_ALL=C
    export LC_ALL
    nl=$'\n'
    bad="$(find . -name "*$nl*" 2>/dev/null)" || exit 1
    [ -z "$bad" ] || exit 1
    bad="$(find . ! -type f ! -type d ! -type l 2>/dev/null)" || exit 1
    [ -z "$bad" ] || exit 1
    dirs="$(find . -type d 2>/dev/null)" || exit 1
    links="$(find . -type l 2>/dev/null)" || exit 1
    plain="$(find . -type f ! -name .DS_Store ! -perm -100 2>/dev/null)" || exit 1
    execs="$(find . -type f ! -name .DS_Store -perm -100 2>/dev/null)" || exit 1
    while IFS= read -r -u 3 p; do
      if [ -n "$p" ] && [ "$p" != . ]; then
        printf 'd %s\n' "${p#./}"
      fi
    done 3<<< "$dirs"
    while IFS= read -r -u 3 p; do
      if [ -n "$p" ]; then
        target="$(readlink "$p")" || exit 1
        printf 'l %s %s\n' "${p#./}" "$target"
      fi
    done 3<<< "$links"
    for kind in f x; do
      if [ "$kind" = f ]; then files="$plain"; else files="$execs"; fi
      while IFS= read -r -u 3 p; do
        if [ -n "$p" ]; then
          h="$(digest_stdin 2>/dev/null < "$p")" || exit 1
          printf '%s %s %s\n' "$kind" "${h#*:}" "${p#./}"
        fi
      done 3<<< "$files"
    done
  )
}

# True when the directory <dest> holds what <src> holds, by diff -rq. No diff -x: BusyBox diff has none,
# so the one thing ignored, a regular file named .DS_Store, is filtered out of diff's own report. diff
# exits 0 (same), 1 (different) or 2 and more (trouble: unreadable, cannot compare), and only 0, or 1 with
# nothing left after the filter, counts. diff follows symlinks, so a symlink in <dest> could pass for a
# file of the source: a managed copy holds none (cp -RL), so one there is the user's, and is a difference.
dirs_equal() {
  local src="$1"
  local dest="$2"
  local out rc line d b links
  out="$(diff -rq "$src" "$dest" 2>/dev/null)" && rc=0 || rc=$?
  if [ "$rc" -ge 2 ]; then
    return 1
  fi
  if [ "$rc" -eq 1 ] && [ -z "$out" ]; then
    return 1
  fi
  links="$(find "$dest" -type l 2>/dev/null)" || return 1
  if [ -n "$links" ]; then
    return 1
  fi
  while IFS= read -r -u 3 line; do
    case "$line" in
      "") ;;
      "Only in "*": .DS_Store")
        d="${line#Only in }"
        d="${d%: .DS_Store}"
        if [ -f "$d/.DS_Store" ] && [ ! -L "$d/.DS_Store" ]; then
          continue
        fi
        return 1
        ;;
      "Files "*"/.DS_Store and "*"/.DS_Store differ")
        b="${line#Files }"
        b="${b% differ}"
        b="${b##* and }"
        if [ -f "$b" ] && [ ! -L "$b" ]; then
          continue
        fi
        return 1
        ;;
      *) return 1 ;;
    esac
  done 3<<< "$out"
  return 0
}
