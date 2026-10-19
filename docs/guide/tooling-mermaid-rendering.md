# Mermaid Rendering

Diagrams are rendered to SVG with the pinned [mermaid-cli](https://github.com/mermaid-js/mermaid-cli) v12 (which bundles mermaid 12, Node >= 22.13).

| Concern | How it is handled |
|---|---|
| Theming | `mermaid.config.json` (light) and `mermaid.dark.config.json` (dark) are the single source of truth. The render script never passes `-t`. |
| Font | `Recursive Variable` is pinned so mermaid embeds it in every SVG. Label geometry is then identical on GitHub, docs sites, and PDF export, instead of depending on whichever of Verdana/Arial/Trebuchet the viewer happens to have. |
| Accessibility | Every diagram carries `accTitle` and `accDescr`, which mermaid emits as `<title>`/`<desc>` wired to `aria-labelledby`. The validator fails the build if one is missing. |
| Duplicates | Symlinked files (`skills/*/SKILL.md`) are skipped, so the master file's diagrams are not rendered twice. |
| Orphans | SVGs from deleted diagrams are pruned on every run. A stale artifact is worse than none. |
| Empty runs | Finding zero mermaid blocks is a hard failure, not a silent success. |
| Missing toolchain | A missing `mmdc` fails validation instead of skipping the gate. A skipped gate that reports success is worse than no gate. |
| Dark mode | The README hero ships light and dark, served through `<picture>` and `prefers-color-scheme`. |
| Drift | CI re-renders and fails if the committed hero no longer matches its Mermaid source. |
| Version | Pinned in `bun.lock`, upgraded deliberately. mermaid-cli 12 bundles mermaid 12 and requires Node >= 22.13. |

```bash
bun install                              # pinned toolchain
bun run render-diagrams                  # all blocks -> diagrams/
bun run validate                         # syntax + a11y + config + hero presence
bun test scripts/                        # unit tests for every script under scripts/
bun run ci                               # render, validate, agents check, size check, tests, snippet drift check
```

These run **locally, by you, before the commit**, not on a hosted runner. Two reasons,
and the second is the one that matters:

1. GitHub Actions minutes on the free tier are the scarce resource here, so the workflow
   at `.github/workflows/ci.yml` is `workflow_dispatch`-only by explicit user policy. It
   has no `push` or `pull_request` trigger, and it should not grow one. The file's header
   carries the reasoning and the exact revert.
2. A hosted runner cannot see your vault, your Snipset database, or your working tree. It
   can only check the portable subset, so a green remote result is weaker evidence than
   the same command run locally, not stronger.

> Only `diagrams/lifecycle.svg` and `diagrams/lifecycle-dark.svg` are committed. Every
> other SVG under `diagrams/` is a build artifact that the render step regenerates and the
> gate prunes: GitHub renders Mermaid code blocks natively, so committing them would add
> megabytes of duplicated output for no reader. The exact count moves as templates are
> added, which is why it is not written down here.

## Why the font is embedded

mermaid-cli 12 inlines the diagram font as base64 `@font-face` blocks, which is why each
rendered SVG is roughly 200 KB rather than 12 KB. That is the deliberate trade. Without
embedding, mermaid measures label widths against whatever font the renderer happens to
have, and a viewer with wider metrics than the build machine silently re-flows or clips
labels. Embedding makes the geometry identical on GitHub, in a docs site, and in PDF
export.

`Recursive Variable` is preferred over `Open Sans` for the same reason mermaid itself
recommends it: it is a variable font, so 4 faces cover every weight, where Open Sans
embeds 20 and doubles the file size. Pass `--no-font-embed` only if you accept per-viewer
label drift.
