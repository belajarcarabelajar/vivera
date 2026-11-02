// Working folders the phone may pick: folders Claude Code already trusts (hasTrustDialogAccepted in
// ~/.claude.json). An untrusted folder would stop the new session at the trust dialog, which the
// phone cannot answer. The home folder is never offered: Claude Code does not persist trust for it.
// A path sent by the phone is matched exactly against this list, never joined or resolved.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export type Folder = { path: string; label: string; mtimeMs: number };

// Also required: hasClaudeMdExternalIncludesWarningShown. ~/CLAUDE.md imports ~/AGENTS.md, a file
// outside every project folder, so a folder that never answered "Allow external CLAUDE.md file
// imports?" stops at that dialog on start (seen 2026-11-02 with ~/Proyek/app).
type ProjectFlags = { hasTrustDialogAccepted?: boolean; hasClaudeMdExternalIncludesWarningShown?: boolean };

export function trustedPaths(claudeJson: string, read = (p: string) => readFileSync(p, "utf8")): string[] {
  try {
    const projects = (JSON.parse(read(claudeJson)) as { projects?: Record<string, ProjectFlags> }).projects ?? {};
    return Object.entries(projects)
      .filter(([, v]) => v?.hasTrustDialogAccepted === true && v?.hasClaudeMdExternalIncludesWarningShown === true)
      .map(([k]) => k);
  } catch {
    return [];
  }
}

export function listFolders(
  candidates: string[],
  home: string,
  stat: (p: string) => { isDirectory(): boolean; mtimeMs: number } = statSync,
): Folder[] {
  const out: Folder[] = [];
  for (const path of new Set(candidates)) {
    if (path === home || !path.startsWith(home + "/") || path.startsWith(home + "/.")) continue;
    try {
      const st = stat(path);
      if (st.isDirectory()) out.push({ path, label: path.replace(home, "~"), mtimeMs: st.mtimeMs });
    } catch {}
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function resolveFolder(choice: string, folders: Folder[]): string | null {
  return folders.find((f) => f.path === choice)?.path ?? null;
}

/**
 * Any existing directory, typed or picked on the phone: "~" and "~/x" expand to the home folder, other
 * paths must be absolute; ".." is normalised. A folder Claude Code does not trust yet is fine: the
 * session then stops at its trust dialog, which is answered from Telegram (see dialog.ts).
 */
export function validateFolder(
  input: string,
  home: string,
  stat: (p: string) => { isDirectory(): boolean } = statSync,
): string | null {
  let p = input.trim();
  if (p === "~") p = home;
  else if (p.startsWith("~/")) p = home + p.slice(1);
  if (!p.startsWith("/") || p.includes("\0") || p.length > 1000) return null;
  p = resolve(p);
  try {
    return stat(p).isDirectory() ? p : null;
  } catch {
    return null;
  }
}

/** Visible sub-directories of `dir` (symlinks to directories included), sorted without regard to case. */
export function listSubdirs(
  dir: string,
  readdir: (p: string) => { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }[] = (p) => readdirSync(p, { withFileTypes: true }),
  stat: (p: string) => { isDirectory(): boolean } = statSync,
): string[] {
  try {
    return readdir(dir)
      .filter((e) => !e.name.startsWith(".") && (e.isDirectory() || (e.isSymbolicLink() && isDir(join(dir, e.name), stat))))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  } catch {
    return [];
  }
}

// dup-defs: allow the mod ships on its own and must not import another mod's internals; small local helper
function isDir(p: string, stat: (p: string) => { isDirectory(): boolean }): boolean {
  try {
    return stat(p).isDirectory();
  } catch {
    return false;
  }
}
