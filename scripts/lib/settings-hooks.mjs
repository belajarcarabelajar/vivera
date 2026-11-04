// scripts/lib/settings-hooks.mjs
//
// Shared helpers for installers that add, replace, or remove their own hook
// entries in a Claude Code settings file that other tools also edit.
//
// An installer owns only the hooks whose command contains one of its owner
// marks (path fragments such as `/scripts/hooks/graphify-`). Everything else
// in the file is foreign and is carried through untouched.

import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { writeFileAtomic } from './atomic-write.mjs';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Hook commands of one matcher entry, skipping hooks without a string command. */
export function commandsOf(entry) {
  if (!Array.isArray(entry?.hooks)) return [];
  return entry.hooks.map((h) => h?.command).filter((c) => typeof c === 'string');
}

const slashes = (s) => s.replaceAll('\\', '/');

/** True when any hook command in this matcher entry contains one of `ownerMarks`. */
export function isOwned(entry, ownerMarks) {
  // Separators are normalised so an entry written on Windows is still recognised.
  const marks = ownerMarks.map(slashes);
  return commandsOf(entry).some((c) => marks.some((m) => slashes(c).includes(m)));
}

/**
 * Removes our hook objects from each entry of `list`; returns the new list and
 * whether anything was removed. Another tool may have put its own hook in the
 * same entry, so ownership is judged per hook here, not per entry: an entry
 * left with foreign hooks keeps them under its matcher, an emptied one is dropped.
 */
function stripOwned(list, ownerMarks) {
  let changed = false;
  const kept = [];
  for (const entry of list) {
    if (!Array.isArray(entry?.hooks)) {
      kept.push(entry);
      continue;
    }
    const hooks = entry.hooks.filter((h) => !isOwned({ hooks: [h] }, ownerMarks));
    if (hooks.length === entry.hooks.length) kept.push(entry);
    else {
      changed = true;
      if (hooks.length > 0) kept.push({ ...entry, hooks });
    }
  }
  return { kept, changed };
}

/** Throws when the settings cannot be merged for `events` without guessing. */
export function validateSettings(settings, events) {
  if (!isPlainObject(settings)) throw new Error('the settings file is not a JSON object');
  if (!Object.hasOwn(settings, 'hooks')) return;
  if (!isPlainObject(settings.hooks)) throw new Error('`hooks` in the settings file is not an object');
  for (const event of events) {
    if (Object.hasOwn(settings.hooks, event) && !Array.isArray(settings.hooks[event])) {
      throw new Error(`\`hooks.${event}\` in the settings file is not an array`);
    }
  }
}

/**
 * Returns a copy of `settings` where, for each event, our old entries are
 * dropped and every entry in `fresh[event]` is appended after the foreign ones.
 */
export function installEntries(settings, fresh, events, ownerMarks) {
  validateSettings(settings, events);
  for (const event of events) {
    for (const entry of fresh[event] ?? []) {
      // Otherwise the next install could not find this entry and would add a second one.
      if (!isOwned(entry, ownerMarks)) {
        throw new Error(`a fresh ${event} entry matches no owner mark (${ownerMarks.join(', ')}), so later runs could not recognise it`);
      }
    }
  }
  const out = structuredClone(settings);
  out.hooks ??= {};
  for (const event of events) {
    const { kept } = stripOwned(out.hooks[event] ?? [], ownerMarks);
    out.hooks[event] = [...kept, ...structuredClone(fresh[event] ?? [])];
  }
  return out;
}

/** Returns a copy of `settings` with only our entries removed. */
export function uninstallEntries(settings, events, ownerMarks) {
  validateSettings(settings, events);
  const out = structuredClone(settings);
  if (!out.hooks) return out;
  let droppedKey = false;
  for (const event of events) {
    const list = out.hooks[event];
    if (!list) continue;
    const { kept, changed } = stripOwned(list, ownerMarks);
    if (!changed) continue;
    // A list that held only our entries was created by an install; an already
    // empty list never reaches here, so a foreign empty key is left alone.
    if (kept.length === 0) {
      delete out.hooks[event];
      droppedKey = true;
    } else {
      out.hooks[event] = kept;
    }
  }
  if (droppedKey && Object.keys(out.hooks).length === 0) delete out.hooks;
  return out;
}

/** One command hook running `file` with the given runtime and extra arguments. */
export function hookCommand(bunPath, file, args = [], timeout = 10) {
  const tail = args.map((a) => ` ${a}`).join('');
  return { type: 'command', command: `"${bunPath}" "${file}"${tail}`, timeout };
}

/** Reads a settings file; a missing file reads as `{}`. Throws on invalid JSON. */
export function readSettings(target) {
  if (!existsSync(target)) return { exists: false, before: null, settings: {} };
  const before = readFileSync(target, 'utf8');
  return { exists: true, before, settings: JSON.parse(before) };
}

/** Writes `text` atomically unless it equals `before`; returns whether it wrote. */
export function writeSettings(target, text, before) {
  // Rewriting identical bytes would replace the one generation backup with a
  // copy of the current file, losing the state from before the first install.
  if (text === before) return false;
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileAtomic(target, text, { keepBackup: true });
  return true;
}
