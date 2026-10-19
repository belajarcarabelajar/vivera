// scripts/lib/docs-gen-files.mjs
//
// A docs page built from several files (source.files in apps/docs/pages.json),
// so a README section too big for one file keeps its page and its hash.

// Returns { files } or { error }, or null when the page names no source at all.
export function sourceFiles(source) {
  const has = (k) => source !== null && typeof source === 'object' && Object.prototype.hasOwnProperty.call(source, k);
  if (has('file') && has('files')) return { error: 'source.file and source.files cannot both be set' };
  if (has('files')) {
    const ok = Array.isArray(source.files) && source.files.length > 0 && source.files.every((f) => typeof f === 'string' && f !== '');
    return ok ? { files: source.files } : { error: 'source.files must be a non-empty list of paths' };
  }
  return typeof source?.file === 'string' && source.file !== '' ? { files: [source.file] } : null;
}

// One blank line between parts, so a section split at H3 boundaries reads as
// the unsplit section. Fences are masked per file: a part never ends inside one.
export function joinParts(parts, fenceMask) {
  const out = { lines: [], mask: [], fileOf: [], lineOf: [] };
  const push = (line, masked, file, n) => {
    out.lines.push(line);
    out.mask.push(masked);
    out.fileOf.push(file);
    out.lineOf.push(n);
  };
  parts.forEach(({ file, text }, k) => {
    const own = text.split('\n');
    while (own.length && own[own.length - 1].trim() === '') own.pop();
    if (k > 0) push('', false, file, 0);
    const mask = fenceMask(own);
    own.forEach((line, i) => push(line, mask[i], file, i + 1));
  });
  return out;
}
