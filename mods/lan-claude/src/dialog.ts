// Reads Claude Code's terminal permission dialog from a tmux screen capture, so a prompt in a session
// that has no hook (one opened by hand) can still be answered from Telegram. Measured 2026-11-02 on
// Claude Code 2.1.316 (Bash, Write, WebFetch): the dialog sits at the bottom, a title and details sit
// between dashed rules (╌), then "Do you want ...?" and numbered options. Option 1 is always exactly
// "Yes"; the "always allow" / "auto mode" options come after it and are never pressed. Deny is Esc.

export type DialogOption = { index: number; label: string; cursor: boolean };
export type PermissionDialog = {
  /** Header and details, without rules and tips: what the user needs to decide. */
  summary: string;
  question: string;
  options: DialogOption[];
  /** Everything above in one string; two dialogs are the same only if this is equal. */
  text: string;
};

const OPTION = /^\s*(❯)?\s*(\d+)\.\s+(.+?)\s*$/;
const DASHED = /^\s*╌{10,}\s*$/;
const SOLID = /^\s*[─▔]{10,}/;

export function parsePermissionDialog(screen: string): PermissionDialog | null {
  const lines = screen.replace(/\s+$/, "").split("\n");
  // The options block must be at the bottom: at most 3 non-option lines (footer) after the last option.
  let last = -1;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 6); i--) {
    if (OPTION.test(lines[i])) {
      last = i;
      break;
    }
  }
  if (last < 0) return null;
  let first = last;
  const options: DialogOption[] = [];
  for (let i = last; i >= 0; i--) {
    const m = OPTION.exec(lines[i]);
    if (m) {
      options.unshift({ index: Number(m[2]), label: m[3], cursor: m[1] === "❯" });
      first = i;
    } else if (/^\s{4,}\S/.test(lines[i]) && i > 0) {
      continue; // wrapped continuation of the option above
    } else {
      break;
    }
  }
  let q = first - 1;
  while (q >= 0 && lines[q].trim() === "") q--;
  const question = q >= 0 ? lines[q].trim() : "";
  if (!/^Do you want\b.*\?$/.test(question)) return null;
  if (options[0]?.index !== 1 || options[0].label !== "Yes") return null;
  if (!options.some((o) => /^No\b/.test(o.label))) return null;
  if (options.some((o, i) => o.index !== i + 1)) return null;
  // Details: from the last solid rule above the question, skipping rules and the auto-mode tip.
  let top = q;
  while (top > 0 && !SOLID.test(lines[top - 1])) top--;
  const block = lines.slice(top, q);
  if (!block.some((l) => DASHED.test(l))) return null; // permission dialogs always draw the dashed box
  const summary = block
    .filter((l) => !DASHED.test(l) && !SOLID.test(l) && !/^\s*Tip:/.test(l))
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
  const text = [summary, question, ...options.map((o) => `${o.index}. ${o.label}`)].join("\n");
  return { summary, question, options, text };
}

// ---------- start-up dialogs (a session that has not started yet) ----------
// Measured 2026-11-02: unlike the permission dialog these options are NOT numbered, and the cursor starts
// on the "No" line, so approving means moving the cursor first:
//   trust:   "No, exit" / "Yes, I trust this folder"                        (footer "Enter to confirm · Esc to cancel")
//   imports: "No, disable external imports" / "Yes, allow external imports"

export type StartupKind = "trust" | "imports";
export type StartupDialog = {
  kind: StartupKind;
  summary: string;
  options: { label: string; cursor: boolean }[];
  /** Index (in `options`) of the "Yes" option. */
  accept: number;
  text: string;
};

const STARTUP: Record<StartupKind, { yes: string; no: string }> = {
  trust: { yes: "Yes, I trust this folder", no: "No, exit" },
  imports: { yes: "Yes, allow external imports", no: "No, disable external imports" },
};

export function parseStartupDialog(screen: string): StartupDialog | null {
  const lines = screen.replace(/\s+$/, "").split("\n");
  let footer = -1;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 4); i--) {
    if (/^\s*Enter to confirm/.test(lines[i])) {
      footer = i;
      break;
    }
  }
  if (footer < 0) return null;
  const optLines: { label: string; cursor: boolean; at: number }[] = [];
  for (let i = footer - 1; i >= 0 && optLines.length < 2; i--) {
    const t = lines[i].trim();
    if (t === "") continue;
    optLines.unshift({ label: t.replace(/^❯\s*/, ""), cursor: t.startsWith("❯"), at: i });
  }
  if (optLines.length !== 2) return null;
  const kind = (Object.keys(STARTUP) as StartupKind[]).find((k) => {
    const labels = optLines.map((o) => o.label).sort().join("|");
    return labels === [STARTUP[k].yes, STARTUP[k].no].sort().join("|");
  });
  if (!kind) return null;
  let top = optLines[0].at;
  while (top > 0 && !SOLID.test(lines[top - 1])) top--;
  const summary = lines
    .slice(top, optLines[0].at)
    .filter((l) => !SOLID.test(l))
    .map((l) => l.trimEnd())
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
  const options = optLines.map((o) => ({ label: o.label, cursor: o.cursor }));
  const accept = options.findIndex((o) => o.label === STARTUP[kind].yes);
  return { kind, summary, options, accept, text: [summary, ...options.map((o) => o.label)].join("\n") };
}
