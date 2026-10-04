// scripts/lib/extract-attachments.mjs
//
// Turn OpenCode's inline attachments into real files that a note can embed.
//
// WHAT THIS IS FOR. OpenCode does not store a user attachment as a path in the
// session log. A `user` message in `session_message.data` carries a `files[]`
// array, and each entry holds the payload inline as base64 in `data` (a real
// one starts `iVBORw0KGgo...` — the PNG magic bytes in base64). 74 messages in
// the imported corpus carried such files, 13.2 MiB in total. So a note that
// wants to show a screenshot has nothing to link to until those bytes become
// files.
//
// THREE RULES THIS FILE EXISTS TO KEEP.
//
//   1. NEVER emit the base64 into note text. It is megabytes of unreadable
//      noise and it is unrecoverable from a note once written (AC-7). Callers
//      embed `embed`; nothing else in the returned object carries payload.
//   2. The extension comes from the magic bytes, not from the name in the log.
//      The name is attacker- and accident-controlled, so it contributes at most
//      a sanitised human hint, never the extension.
//   3. The filename is a pure function of (session, message, content). Re-runs
//      target the same path instead of churning the vault (AC-8), and two
//      different images in one message cannot land on one file.
//
// AND THE PATH THEY NAME IS NOT REWRITTEN FOR NOTHING. Same policy as
// `sync-writer.mjs` for notes: with obsidian-git pushing on a timer, identical
// bytes are not written — not touched at all, mtime included.
//
// Fallback for unrecognised content: `FALLBACK_EXT` (`.bin`). Never a throw —
// one odd attachment must not abort the import of a whole session.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// The documented fallback extension. Exported so a caller reporting on an
// import can name it without hardcoding the string.
export const FALLBACK_EXT = '.bin';

// Magic-byte table, longest-offset first. Offsets matter: WEBP is `RIFF` at 0
// and `WEBP` at 8, so it cannot be a plain prefix match.
const SIGNATURES = [
  { ext: '.png', mime: 'image/png', test: (b) => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a },
  { ext: '.jpg', mime: 'image/jpeg', test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: '.gif', mime: 'image/gif', test: (b) => b.length >= 6 && b.subarray(0, 6).toString('ascii') === 'GIF89a' || (b.length >= 4 && b.subarray(0, 4).toString('ascii') === 'GIF8') },
  { ext: '.webp', mime: 'image/webp', test: (b) => b.length >= 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP' },
  { ext: '.pdf', mime: 'application/pdf', test: (b) => b.length >= 5 && b.subarray(0, 5).toString('ascii') === '%PDF-' },
];

/**
 * The extension implied by a buffer's leading bytes.
 * Returns FALLBACK_EXT when nothing matches; never throws.
 * @param {Buffer} buf
 * @returns {string} including the leading dot
 */
export function sniffExtension(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return FALLBACK_EXT;
  for (const sig of SIGNATURES) {
    try {
      if (sig.test(buf)) return sig.ext;
    } catch {
      // A short buffer can only ever fail a bounds read; treat it as unknown
      // rather than letting the classifier take the import down.
    }
  }
  return FALLBACK_EXT;
}

/**
 * The MIME type implied by a buffer's leading bytes, for reporting only.
 * @param {Buffer} buf
 * @returns {string}
 */
export function sniffMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return 'application/octet-stream';
  for (const sig of SIGNATURES) {
    try {
      if (sig.test(buf)) return sig.mime;
    } catch {
      // as above
    }
  }
  return 'application/octet-stream';
}

// Everything outside this set is replaced. The set is deliberately small: no
// `/`, no `\`, no `:`, no space, no leading dot-run, so the result can never be
// a path, an absolute path, a hidden file, or `..`.
const UNSAFE = /[^A-Za-z0-9._-]+/g;

/**
 * Reduce an untrusted string to a safe path segment.
 * @param {unknown} raw
 * @param {{fallback?: string, maxLength?: number}} [opts]
 * @returns {string}
 */
function safeSegment(raw, { fallback = 'attachment', maxLength = 60 } = {}) {
  if (typeof raw !== 'string') return fallback;
  const stripped = raw.replace(UNSAFE, '-').replace(/^\.+/, '').replace(/\.+$/, '');
  if (!stripped || stripped === fallback) return fallback;
  return stripped.slice(0, maxLength).replace(/^\.+/, '') || fallback;
}

/**
 * The filename stem the caller may have supplied, with any extension removed
 * and the extension then re-derived from the content. Never returned verbatim.
 * @param {unknown} filename
 * @returns {string}
 */
function hintStem(filename) {
  if (typeof filename !== 'string' || filename.trim() === '') return 'attachment';
  // basename first, in both separator flavours, so `../../evil.png` and
  // `sub\dir\nested.png` both reduce to a single segment before sanitising.
  const base = filename.split(/[\\/]/).pop() ?? '';
  const withoutExt = base.replace(/\.[^.]*$/, '');
  return safeSegment(withoutExt, { fallback: 'attachment', maxLength: 40 });
}

/**
 * Strip a `data:<mime>;base64,` prefix if present.
 * @param {string} s
 * @returns {string}
 */
function stripDataUri(s) {
  const m = /^data:[^;,]*;base64,/i.exec(s);
  return m ? s.slice(m[0].length) : s;
}

/**
 * Strict base64 decode. `Buffer.from(s, 'base64')` is deliberately lenient: it
 * throws away characters it does not recognise and silently drops a truncated
 * tail, so an unusable payload would decode to a plausible-looking short file.
 * The round-trip check is what makes this strict — anything that does not
 * re-encode to itself is rejected rather than truncated.
 * @param {unknown} data
 * @returns {{ok: true, buffer: Buffer} | {ok: false, reason: string}}
 */
function decodeStrict(data) {
  if (typeof data !== 'string') return { ok: false, reason: 'entry has no string base64 data field' };
  const raw = stripDataUri(data).replace(/\s+/g, '');
  if (raw === '') return { ok: false, reason: 'base64 data is empty' };
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return { ok: false, reason: 'base64 data contains characters outside the alphabet' };
  const body = raw.replace(/=+$/, '');
  if (body.length % 4 === 1) return { ok: false, reason: 'base64 data is truncated (length is not a multiple of 4)' };
  const buffer = Buffer.from(body, 'base64');
  if (buffer.length === 0) return { ok: false, reason: 'base64 data decoded to zero bytes' };
  // Re-encode without padding; a mismatch means the trailing bits were garbage,
  // i.e. the payload is corrupt rather than merely unusual.
  if (buffer.toString('base64').replace(/=+$/, '') !== body) {
    return { ok: false, reason: 'base64 data does not round-trip (corrupt payload)' };
  }
  return { ok: true, buffer };
}

/**
 * The wikilink embed for a written file.
 *
 * The target vault leaves `useMarkdownLinks` unset in `.obsidian/app.json`,
 * which means Obsidian resolves `[[wikilinks]]`, not markdown links. So this is
 * `![[<path>]]` and not `![](path)`.
 *
 * @param {string} filePath absolute path of the written file
 * @param {string} base directory the link is relative to
 * @returns {string}
 */
function wikilinkEmbed(filePath, base) {
  let rel = path.relative(base, filePath);
  // A link that climbs out of its base is not a link a reader can follow.
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) rel = path.basename(filePath);
  return `![[${rel.split(path.sep).join('/')}]]`;
}

/**
 * True when `abs` already holds exactly these bytes.
 *
 * Read-then-compare, never "write it anyway and look at the mtime afterwards"
 * (the publication reason is the module header). `Buffer.equals` is the whole
 * point — no trimming, no newline normalisation, no encoding round trip.
 * Anything looser would call a file unchanged when it is not, and the
 * difference would then never be published.
 *
 * @param {string} abs absolute path of the destination file
 * @param {Buffer} next bytes about to be written
 * @returns {boolean} true only if the file exists and matches byte for byte
 */
function bytesAlreadyOnDisk(abs, next) {
  let existing;
  try {
    existing = readFileSync(abs);
  } catch (err) {
    // ENOENT: absent. ENOTDIR: a component above the leaf is a file, so the leaf
    // cannot exist either. Both mean "nothing there yet", i.e. write it.
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return false;
    // Anything else — EACCES, EIO — is a real failure and must not be silently
    // reported as "unchanged", because that would skip a write that has to happen.
    throw err;
  }
  return existing.equals(next);
}

/**
 * Extract a user message's inline attachments into real files.
 *
 * Each result is either a written attachment
 * `{ index, filename, path, embed, bytes, mime, skipped: false, unchanged }` or a
 * skipped entry `{ index, filename: null, path: null, embed: null, bytes: 0,
 * reason, skipped: true }`. The index is always the entry's position in `files`,
 * so a skip never shifts the alignment between the log and the note.
 *
 * `unchanged` is the content-aware-write result and is the point of this flag: it
 * is true when the destination already held byte-identical content, in which
 * case the file was not opened for writing at all and its mtime is exactly what
 * it was. It is false when the bytes were written, whether the file was new or
 * its content differed. A skipped entry carries no `unchanged` key: nothing was
 * written and nothing was compared, so any value would be a lie.
 *
 * @param {Array<object|string>} files the `files[]` array from a user message
 * @param {string} destDir directory to write into; created recursively if absent
 * @param {object} [opts]
 * @param {string} [opts.sessionId] session context, folded into the filename
 * @param {string} [opts.messageId] message context, folded into the filename
 * @param {string} [opts.vaultRoot] base the embed path is relative to
 * @param {(entry: object) => void} [opts.onSkip] called once per skipped entry
 * @returns {Array<object>} one result per input entry, in order
 */
export function extractAttachments(files, destDir, opts = {}) {
  if (typeof destDir !== 'string' || destDir.trim() === '') {
    throw new TypeError('extractAttachments: destDir must be a non-empty string');
  }
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return [];

  const dest = path.resolve(destDir);
  const { sessionId = 'session', messageId = 'message', vaultRoot, onSkip } = opts;
  const embedBase = typeof vaultRoot === 'string' && vaultRoot.trim() !== ''
    ? path.resolve(vaultRoot)
    : dest;

  const prefix = `${safeSegment(sessionId, { fallback: 'session', maxLength: 32 })}-${safeSegment(messageId, { fallback: 'message', maxLength: 32 })}`;
  const cache = new Map(); // filename -> result, so identical content in one call is written once

  // One mkdir, before any decode: a broken destination is a real failure and is
  // reported as an exception, never as a per-entry skip.
  mkdirSync(dest, { recursive: true });

  return list.map((entry, index) => {
    if (typeof entry === 'string') {
      return skip(index, 'entry is a path string, not inline base64 data', onSkip);
    }
    if (!entry || typeof entry !== 'object') {
      return skip(index, 'entry is not an object with a base64 data field', onSkip);
    }
    const decoded = decodeStrict(entry.data);
    if (!decoded.ok) return skip(index, decoded.reason, onSkip);

    const buffer = decoded.buffer;
    const ext = sniffExtension(buffer);
    // Content hash, not position: two different images never share a name, and
    // re-running the import reproduces the name exactly.
    const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 16);
    const filename = `${prefix}-${hintStem(entry.filename)}-${hash}${ext}`;

    const filePath = path.join(dest, filename);
    // Belt and braces: the name is already a safe segment, so this can only
    // fire if that invariant is ever broken. Cheap, and it fails closed.
    if (path.dirname(path.resolve(filePath)) !== dest) {
      throw new Error(`extractAttachments: computed filename escaped destDir: ${filename}`);
    }

    let result = cache.get(filename);
    if (result === undefined) {
      // Content-aware write, and the only difference from writing unconditionally:
      // on a match the file is not opened at all (why: module header). The
      // filename is computed exactly as before, so a run that used to rewrite a
      // path now skips it instead — never a different path.
      const unchanged = bytesAlreadyOnDisk(filePath, buffer);
      if (!unchanged) writeFileSync(filePath, buffer);
      result = {
        index,
        filename,
        path: filePath,
        embed: wikilinkEmbed(filePath, embedBase),
        bytes: buffer.length,
        mime: sniffMime(buffer),
        skipped: false,
        unchanged,
      };
      cache.set(filename, result);
    }
    // Same file, second position in `files`: report the new index so the
    // caller can still pair each note line with its log entry.
    return { ...result, index };
  });
}

function skip(index, reason, onSkip) {
  const entry = {
    index,
    filename: null,
    path: null,
    embed: null,
    bytes: 0,
    mime: null,
    skipped: true,
    reason,
  };
  if (typeof onSkip === 'function') onSkip(entry);
  return entry;
}