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

## Harvest Sprite portraits (not MIT)

- Location in this repo: `docs/images/sprites/` (`chef.png`, `nappy.png`, `hoggy.png`,
  `timid.png`, `aqua.png`, `staid.png`, `bold.png`), shown in `README.md`.
- What they are: portraits of the seven Harvest Sprites from *Harvest Moon: Back to
  Nature*. The artwork is not original to this repository, and its copyright belongs to
  its respective owners. The repository's MIT license does not cover these seven files.
- Source: the Harvest Moon Wiki (Fandom), files `Harvest Sprite Red 1.png`, `Orange`,
  `Yellow`, `Green`, `Blue`, `Indigo`, and `Purple`, each 86 x 105 px, fetched
  2026-10-11 from the pages `Chef_(BTN)`, `Nappy_(BTN)`, `Hoggy_(BTN)`, `Timid_(BTN)`,
  `Aqua_(BTN)`, `Staid_(BTN)`, and `Bold_(BTN)`. The README facts (birthdays, colors)
  come from https://harvestmoon.fandom.com/wiki/Harvest_Sprites_(BTN).
- Modification: enlarged 4x to 344 x 420 px with Real-ESRGAN `realesrgan-x4plus-anime`
  (realesrgan-ncnn-vulkan 20220424), alpha silhouette smoothed separately, embedded
  PNG text metadata stripped. No other change to the drawings.
- Removal: delete `docs/images/sprites/` and the "The Harvest Sprites" section of
  `README.md`.
