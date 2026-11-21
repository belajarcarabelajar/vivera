// scripts/lib/files-root.mjs
//
// Where a task's declared `files` resolve, and the two checks that read them.
// Split out of ultra-plan-runner.mjs, which sits at its size ceiling.
//
// A plan that names its files is making a falsifiable claim: "this task touches
// these paths and nothing else." Checking it is cheap and catches two real
// defects. A path in `modify`/`test` that does not exist means the plan is
// describing a codebase that is not there, and a path in `create` that still
// does not exist after the steps ran means the task did not do what it said.
//
// `create` is deliberately NOT required to be absent beforehand. A task whose
// file already exists is usually one being re-run, and failing it for that
// would make idempotency impossible. What matters is the end state.
//
// `files_root` is the folder a task's relative paths resolve against. Without
// it they resolve against the runner's cwd, which is wrong for a plan run from
// one repository about files in another: the 31 to 35 close ran from the vivera
// checkout with bcb paths, and every precondition failed. Absolute paths resolve
// as written either way. Only `files` follows the key: `skip_if` and `run[]`
// keep the runner's cwd, because module plans already `cd` inside the command.

import { existsSync } from 'node:fs';
import path from 'node:path';

// Absolute and nothing else. A relative root would resolve against the cwd the
// key exists to get away from, and the directory is not required to exist at
// validation time: a plan is validated before the worktree it names is made.
export function validateFilesRoot(plan, errors) {
  for (const t of plan.tasks || []) {
    if (!t || !('files_root' in t)) continue;
    const v = t.files_root;
    if (typeof v !== 'string' || v.trim() === '' || !path.isAbsolute(v)) {
      errors.push(`task ${t.id} files_root must be an absolute directory, got ${JSON.stringify(v)}`);
    }
  }
}

const filesBase = (t, dir) => (typeof t.files_root === 'string' && path.isAbsolute(t.files_root) ? t.files_root : dir);

function absent(t, dir, groups) {
  const files = t.files;
  if (!files || typeof files !== 'object') return null;
  const base = filesBase(t, dir);
  const missing = [];
  for (const group of groups) {
    for (const f of files[group] || []) {
      if (typeof f !== 'string' || f === '') continue;
      if (!existsSync(path.resolve(base, f))) missing.push(`${group}: ${f}`);
    }
  }
  return missing.length ? missing : null;
}

export const filePrecondition = (t, dir) => absent(t, dir, ['modify', 'test']);
export const filePostcondition = (t, dir) => absent(t, dir, ['create']);
