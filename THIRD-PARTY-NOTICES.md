# Third-Party Notices

This repository includes code from the following third-party projects. This file
provides the attribution required by their licenses.

## graphify

- Location in this repo:
  - `.opencode/skills/graphify/` (SKILL.md plus the files under `references/`)
  - `.opencode/plugins/graphify.js` (OpenCode plugin)
- Upstream: https://github.com/safishamsi/graphify (canonical repository now
  maintained as https://github.com/Graphify-Labs/graphify)
- Copyright (c) 2026 Safi Shamsi
- License: MIT (dual-licensed upstream under Apache-2.0 and MIT; the MIT terms
  in `LICENSE-MIT` apply to this copy)
- Note: the skill copy in this repository is included unmodified; the OpenCode
  plugin carries local modifications for this repository and may include
  upstream code, which remains covered by the same upstream license.

Footnote: upstream license verified on 2026-10-03 from
https://github.com/safishamsi/graphify and the file `LICENSE-MIT` on branch
`v8` (fetched via https://raw.githubusercontent.com/Graphify-Labs/graphify/v8/LICENSE-MIT),
which reads "Copyright (c) 2026 Safi Shamsi" under the MIT License.

Note on the MIT License: it requires that the upstream copyright notice be kept
with substantial portions of the software. This file provides that notice for
the copies listed above.

## Pagefind

- Location: not stored in this repository. The docs site build
  (`scripts/docs-remote.sh build`) runs `bunx pagefind@1.5.2`, which writes the
  Pagefind UI (`pagefind-ui.js`, `pagefind-ui.css`), its search runtime, and the
  generated index files into `apps/docs/dist/docs/pagefind/`. Those files ship
  with the published docs site, which loads the UI from `apps/docs/assets/docs.js`.
- Upstream: https://github.com/Pagefind/pagefind (formerly
  https://github.com/CloudCannon/pagefind), npm package `pagefind` 1.5.2
- Copyright 2022 Pagefind
- License: MIT

Footnote: license verified on 2026-10-17 from
https://raw.githubusercontent.com/CloudCannon/pagefind/main/LICENSE, which reads
"Copyright 2022 Pagefind" under the MIT License, and from the npm registry entry
https://registry.npmjs.org/pagefind/1.5.2 (`"license": "MIT"`).

## Harvest Sprites artwork

- Location in this repo: `docs/images/harvest-sprites-crew.png` and `docs/images/sprites/`.
- The illustration and the seven portraits are original artwork drawn for this repository as SVG
  (sources beside each PNG) and are covered by its MIT license. They replace, since 2026-10-27,
  game artwork from the Harvest Moon Wiki that earlier commits carried. Only the sprite names and
  their rainbow colors come from *Harvest Moon: Back to Nature*.
- The game facts on the sprites page and their sources are listed in `docs/vivera-glossary.md`.
