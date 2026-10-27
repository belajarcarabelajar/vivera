// scripts/lib/docs-gen-fence.mjs
//
// Which lines of a Markdown text sit inside a fenced code block. Split out of
// scripts/docs-gen.mjs, which re-exports it.

export function fenceMask(lines) {
  const mask = new Array(lines.length).fill(false);
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (open) {
      mask[i] = true;
      const close = line.match(/^\s*(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === open[0] && close[1].length >= open.length) open = null;
      continue;
    }
    const m = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    // A backtick info string cannot contain a backtick, so such a line is inline code.
    if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
      open = m[1];
      mask[i] = true;
    }
  }
  return mask;
}
