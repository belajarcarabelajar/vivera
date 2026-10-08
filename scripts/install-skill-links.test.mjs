import { test, expect } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { planLinks, applyActions } from "./install-skill-links.mjs";

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-links-"));
  const source = path.join(root, "vivera-skills");
  const target = path.join(root, "registry");
  fs.mkdirSync(path.join(source, "sucp-rules"), { recursive: true });
  fs.writeFileSync(path.join(source, "sucp-rules", "SKILL.md"), "x");
  fs.mkdirSync(path.join(source, "sucp-plan"), { recursive: true });
  fs.writeFileSync(path.join(source, "sucp-plan", "SKILL.md"), "x");
  fs.mkdirSync(path.join(source, "notaskill"), { recursive: true });
  fs.mkdirSync(target, { recursive: true });
  return { root, source, target };
}

test("links missing skills and ignores directories without SKILL.md", () => {
  const { source, target } = setup();
  const actions = planLinks(source, target);
  expect(actions.map((a) => a.name).sort()).toEqual(["sucp-plan", "sucp-rules"]);
  applyActions(actions);
  expect(fs.readlinkSync(path.join(target, "sucp-rules"))).toBe(path.join(source, "sucp-rules"));
  expect(planLinks(source, target).every((a) => a.action === "ok")).toBe(true);
});

test("repoints a broken link and a link into vivera, but leaves foreign links alone", () => {
  const { source, target } = setup();
  fs.symlinkSync("/nonexistent/path", path.join(target, "sucp-rules"));
  fs.mkdirSync(path.join(source, "..", "elsewhere"), { recursive: true });
  fs.symlinkSync(path.join(source, "..", "elsewhere"), path.join(target, "sucp-plan"));
  const byName = Object.fromEntries(planLinks(source, target).map((a) => [a.name, a]));
  expect(byName["sucp-rules"].action).toBe("relink");
  expect(byName["sucp-plan"].action).toBe("skip");
});

test("merges a real directory file by file and never replaces a real file", () => {
  const { source, target } = setup();
  fs.mkdirSync(path.join(source, "sucp-plan", "templates"), { recursive: true });
  fs.writeFileSync(path.join(source, "sucp-plan", "extra.md"), "x");
  fs.mkdirSync(path.join(target, "sucp-plan"));
  fs.writeFileSync(path.join(target, "sucp-plan", "SKILL.md"), "real file");
  const actions = planLinks(source, target).filter((a) => a.name.startsWith("sucp-plan/"));
  const byName = Object.fromEntries(actions.map((a) => [a.name, a]));
  expect(byName["sucp-plan/SKILL.md"].action).toBe("skip");
  expect(byName["sucp-plan/extra.md"].action).toBe("link");
  applyActions(actions);
  expect(fs.readFileSync(path.join(target, "sucp-plan", "SKILL.md"), "utf8")).toBe("real file");
  expect(fs.readlinkSync(path.join(target, "sucp-plan", "extra.md"))).toBe(path.join(source, "sucp-plan", "extra.md"));
});
