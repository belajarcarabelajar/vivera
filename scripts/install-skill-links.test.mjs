import { test, expect, afterAll } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { planLinks, applyActions } from "./install-skill-links.mjs";

// Every root setup() made, removed after the last test so a run leaves nothing in the temp dir.
const roots = [];
afterAll(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-links-"));
  roots.push(root);
  const source = path.join(root, "vivera-skills");
  const target = path.join(root, "registry");
  fs.mkdirSync(path.join(source, "vivera-rules"), { recursive: true });
  fs.writeFileSync(path.join(source, "vivera-rules", "SKILL.md"), "x");
  fs.mkdirSync(path.join(source, "vivera-plan"), { recursive: true });
  fs.writeFileSync(path.join(source, "vivera-plan", "SKILL.md"), "x");
  fs.mkdirSync(path.join(source, "notaskill"), { recursive: true });
  fs.mkdirSync(target, { recursive: true });
  return { root, source, target };
}

test("links missing skills and ignores directories without SKILL.md", () => {
  const { source, target } = setup();
  const actions = planLinks(source, target);
  expect(actions.map((a) => a.name).sort()).toEqual(["vivera-plan", "vivera-rules"]);
  applyActions(actions);
  expect(fs.readlinkSync(path.join(target, "vivera-rules"))).toBe(path.join(source, "vivera-rules"));
  expect(planLinks(source, target).every((a) => a.action === "ok")).toBe(true);
});

test("repoints a broken link and a link into vivera, but leaves foreign links alone", () => {
  const { source, target } = setup();
  fs.symlinkSync("/nonexistent/path", path.join(target, "vivera-rules"));
  fs.mkdirSync(path.join(source, "..", "elsewhere"), { recursive: true });
  fs.symlinkSync(path.join(source, "..", "elsewhere"), path.join(target, "vivera-plan"));
  const byName = Object.fromEntries(planLinks(source, target).map((a) => [a.name, a]));
  expect(byName["vivera-rules"].action).toBe("relink");
  expect(byName["vivera-plan"].action).toBe("skip");
});

test("merges a real directory file by file and never replaces a real file", () => {
  const { source, target } = setup();
  fs.mkdirSync(path.join(source, "vivera-plan", "templates"), { recursive: true });
  fs.writeFileSync(path.join(source, "vivera-plan", "extra.md"), "x");
  fs.mkdirSync(path.join(target, "vivera-plan"));
  fs.writeFileSync(path.join(target, "vivera-plan", "SKILL.md"), "real file");
  const actions = planLinks(source, target).filter((a) => a.name.startsWith("vivera-plan/"));
  const byName = Object.fromEntries(actions.map((a) => [a.name, a]));
  expect(byName["vivera-plan/SKILL.md"].action).toBe("skip");
  expect(byName["vivera-plan/extra.md"].action).toBe("link");
  applyActions(actions);
  expect(fs.readFileSync(path.join(target, "vivera-plan", "SKILL.md"), "utf8")).toBe("real file");
  expect(fs.readlinkSync(path.join(target, "vivera-plan", "extra.md"))).toBe(path.join(source, "vivera-plan", "extra.md"));
});
