import { describe, expect, test } from "bun:test";
import { listFolders, resolveFolder, trustedPaths } from "../src/folders";

const home = "/home/u";
const json = JSON.stringify({
  projects: {
    "/home/u": { hasTrustDialogAccepted: false },
    "/home/u/vivera": { hasTrustDialogAccepted: true, hasClaudeMdExternalIncludesWarningShown: true },
    "/home/u/Proyek/a": { hasTrustDialogAccepted: true, hasClaudeMdExternalIncludesWarningShown: true },
    "/home/u/Proyek/imports-dialog": { hasTrustDialogAccepted: true, hasClaudeMdExternalIncludesWarningShown: false },
    "/home/u/Proyek/new": {},
    "/home/u/.cache/tmp/x": { hasTrustDialogAccepted: true, hasClaudeMdExternalIncludesWarningShown: true },
    "/mnt/ext/wt": { hasTrustDialogAccepted: true, hasClaudeMdExternalIncludesWarningShown: true },
    "/home/u/Proyek/gone": { hasTrustDialogAccepted: true, hasClaudeMdExternalIncludesWarningShown: true },
  },
});

describe("folders", () => {
  test("only trusted folders inside home, never home itself, hidden dirs, or missing ones", () => {
    const paths = trustedPaths("/x", () => json);
    const stat = (p: string) => {
      if (p.endsWith("gone")) throw new Error("ENOENT");
      return { isDirectory: () => true, mtimeMs: p.endsWith("/a") ? 2 : 1 };
    };
    expect(listFolders(paths, home, stat).map((f) => f.label)).toEqual(["~/Proyek/a", "~/vivera"]);
  });

  test("unreadable ~/.claude.json gives no folders", () => {
    expect(trustedPaths("/x", () => { throw new Error("nope"); })).toEqual([]);
  });

  test("the phone can only pick an exact listed path", () => {
    const fs = [{ path: "/home/u/vivera", label: "~/vivera", mtimeMs: 1 }];
    expect(resolveFolder("/home/u/vivera", fs)).toBe("/home/u/vivera");
    expect(resolveFolder("/home/u/vivera/../..", fs)).toBeNull();
    expect(resolveFolder("/home/u", fs)).toBeNull();
  });
});
