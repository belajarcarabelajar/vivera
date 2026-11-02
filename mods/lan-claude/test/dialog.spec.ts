import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parsePermissionDialog } from "../src/dialog";

const fx = (n: string) => readFileSync(`${import.meta.dir}/fixtures/${n}.txt`, "utf8");

describe("permission dialog parser (real captures, Claude Code 2.1.316)", () => {
  test("Bash", () => {
    const d = parsePermissionDialog(fx("bash"))!;
    expect(d.question).toBe("Do you want to proceed?");
    expect(d.options.map((o) => o.label)).toEqual([
      "Yes",
      "Yes, and always allow access to /home/u/.cache/tmp/lc-perm from this project",
      "Yes, and switch to auto mode · auto mode handles these prompts for you",
      "No",
    ]);
    expect(d.options[0]).toEqual({ index: 1, label: "Yes", cursor: true });
    expect(d.summary).toContain("Bash command");
    expect(d.summary).toContain("touch /home/u/.cache/tmp/lc-perm/made-bash.txt");
    expect(d.summary).not.toContain("Tip:");
    expect(d.summary).not.toContain("╌");
  });

  test("Write (option 2 wraps onto two lines)", () => {
    const d = parsePermissionDialog(fx("write"))!;
    expect(d.question).toBe("Do you want to create made-write.txt?");
    expect(d.options.map((o) => o.index)).toEqual([1, 2, 3]);
    expect(d.options[2].label).toBe("No");
    expect(d.summary).toContain("Create file");
    expect(d.summary).toContain("halo dari uji");
  });

  test("WebFetch (no footer line, last option is 'No, and tell Claude...')", () => {
    const d = parsePermissionDialog(fx("webfetch"))!;
    expect(d.question).toBe("Do you want to allow Claude to fetch this content?");
    expect(d.options[2].label).toMatch(/^No, and tell Claude/);
    expect(d.summary).toContain("url: https://example.com/");
  });

  test("identical dialogs compare equal, different commands do not", () => {
    expect(parsePermissionDialog(fx("bash"))!.text).toBe(parsePermissionDialog(fx("bash"))!.text);
    expect(parsePermissionDialog(fx("bash"))!.text).not.toBe(parsePermissionDialog(fx("write"))!.text);
  });

  test("never matches things that are not a permission dialog", () => {
    const rule = "─".repeat(40);
    const dashed = "╌".repeat(40);
    // AskUserQuestion-style list: options but no "Do you want", no dashed box
    expect(parsePermissionDialog(`${rule}\n Pilih salah satu?\n ❯ 1. Yes\n   2. No\n Enter to select · Esc to cancel`)).toBeNull();
    // "Do you want" question but option 1 is not exactly Yes
    expect(parsePermissionDialog(`${rule}\n x\n${dashed}\n y\n${dashed}\n Do you want to proceed?\n ❯ 1. Yes, and always allow\n   2. No`)).toBeNull();
    // no No option
    expect(parsePermissionDialog(`${rule}\n x\n${dashed}\n y\n${dashed}\n Do you want to proceed?\n ❯ 1. Yes\n   2. Maybe`)).toBeNull();
    // dialog scrolled off: options not at the bottom
    expect(parsePermissionDialog(fx("bash") + "\n\n\n\n\n\n\nteks lain\nteks lain\nteks lain\nteks lain\nteks lain\nteks lain")).toBeNull();
    expect(parsePermissionDialog("")).toBeNull();
  });
});

import { parseStartupDialog } from "../src/dialog";
import { listSubdirs, validateFolder } from "../src/folders";

describe("start-up dialogs (real captures)", () => {
  test("trust dialog: unnumbered, cursor on No, accept is the second option", () => {
    const d = parseStartupDialog(fx("trust"))!;
    expect(d.kind).toBe("trust");
    expect(d.options).toEqual([{ label: "No, exit", cursor: true }, { label: "Yes, I trust this folder", cursor: false }]);
    expect(d.accept).toBe(1);
    expect(d.summary).toContain("Accessing workspace:");
    expect(d.summary).toContain("/lc-trust-test/proj");
  });

  test("imports dialog", () => {
    const d = parseStartupDialog(fx("imports"))!;
    expect(d.kind).toBe("imports");
    expect(d.accept).toBe(1);
    expect(d.summary).toContain("/home/u/AGENTS.md");
  });

  test("not fooled by other screens", () => {
    expect(parseStartupDialog(fx("bash"))).toBeNull();
    expect(parseStartupDialog("")).toBeNull();
    expect(parseStartupDialog("x\n ❯ Pilihan A\n   Pilihan B\n Enter to confirm · Esc to cancel")).toBeNull();
    expect(parsePermissionDialog(fx("trust"))).toBeNull();
  });
});

describe("folders anywhere", () => {
  const dirs = new Set(["/home/u", "/home/u/Unduhan", "/etc", "/"]);
  const stat = (p: string) => {
    if (!dirs.has(p) && p !== "/home/u/file.txt") throw new Error("ENOENT");
    return { isDirectory: () => dirs.has(p) };
  };
  test("validateFolder expands ~, normalises, and accepts only existing directories", () => {
    expect(validateFolder("~", "/home/u", stat)).toBe("/home/u");
    expect(validateFolder("~/Unduhan", "/home/u", stat)).toBe("/home/u/Unduhan");
    expect(validateFolder("/etc", "/home/u", stat)).toBe("/etc");
    expect(validateFolder("/home/u/Unduhan/../Unduhan/", "/home/u", stat)).toBe("/home/u/Unduhan");
    expect(validateFolder("/", "/home/u", stat)).toBe("/");
    expect(validateFolder("Unduhan", "/home/u", stat)).toBeNull();
    expect(validateFolder("/home/u/file.txt", "/home/u", stat)).toBeNull();
    expect(validateFolder("/tidak/ada", "/home/u", stat)).toBeNull();
    expect(validateFolder("", "/home/u", stat)).toBeNull();
    expect(validateFolder("/etc\0x", "/home/u", stat)).toBeNull();
  });

  test("listSubdirs hides dot folders, keeps directory symlinks, sorts case-insensitively", () => {
    const ents = [
      { name: "b", isDirectory: () => true, isSymbolicLink: () => false },
      { name: ".git", isDirectory: () => true, isSymbolicLink: () => false },
      { name: "A", isDirectory: () => true, isSymbolicLink: () => false },
      { name: "file.txt", isDirectory: () => false, isSymbolicLink: () => false },
      { name: "Video", isDirectory: () => false, isSymbolicLink: () => true },
      { name: "rusak", isDirectory: () => false, isSymbolicLink: () => true },
    ];
    const st = (p: string) => {
      if (p.endsWith("/Video")) return { isDirectory: () => true };
      throw new Error("ENOENT");
    };
    expect(listSubdirs("/home/u", () => ents, st)).toEqual(["A", "b", "Video"]);
    expect(listSubdirs("/tidak/ada", () => { throw new Error("x"); })).toEqual([]);
  });
});
