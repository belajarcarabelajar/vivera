// graphify OpenCode plugin (V2)
// Injects a knowledge graph reminder before bash tool calls when the graph exists.
//
// IMPORTANT: keep the reminder string free of backticks and $(...) constructs.
// The hook prepends `echo "<reminder>" ; <cmd>` to the user's bash command;
// backticks inside the double-quoted echo trigger bash command substitution,
// which both corrupts tool output and silently executes the very graphify
// command we are only suggesting. Plain words render fine in opencode's TUI.
import { existsSync } from "fs";
import { join } from "path";

// NOTE: no runtime import from "@opencode/plugin" here on purpose.
// A bare .js file under .opencode/plugins/ has no node_modules to resolve it
// from, so `import { Plugin } from "@opencode/plugin"` fails with
// "Cannot find package". OpenCode v2 only requires a default export with an
// `id` and a `setup` function, so a plain object is enough (same pattern as
// ~/.config/opencode/plugins/rtk.ts, which uses `import type` only).

const REMINDER =
  "[graphify] knowledge graph at graphify-out/. For focused questions, run graphify query with your question (scoped subgraph, usually much smaller than GRAPH_REPORT.md) instead of grepping raw files. Read GRAPH_REPORT.md only for broad architecture context.";

export default {
  // Unique id: the global plugin already owns "graphify". Colliding ids made
  // this project-scoped copy register as a duplicate.
  id: "graphify-ai-skills",
  async setup(ctx) {
    let reminded = false;

    await ctx.tool.hook("execute.before", (event) => {
      if (reminded) return;
      if (event.tool !== "bash") return;

      const directory = ctx.location.directory;
      if (!directory) return;
      if (!existsSync(join(directory, "graphify-out", "graph.json"))) return;

      const input = event.input;
      if (!input || typeof input.command !== "string") return;

      // A differently-id'd copy of this plugin (e.g. ~/.opencode/plugins and
      // ~/vivera/.opencode/plugins) may already have injected the reminder.
      // Reuse its marker so only one echo is prepended per session.
      if (input.command.includes("[graphify]")) {
        reminded = true;
        return;
      }

      // ';' not '&&' — Windows PowerShell 5.1 rejects '&&' as a statement
      // separator, breaking the first bash command of the session (#1646).
      input.command = 'echo "' + REMINDER + '" ; ' + input.command;
      reminded = true;
    });
  },
};
