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

## Harvest Sprites illustration (not MIT)

- Location in this repo: `docs/images/btn-harvest-sprites.jpg`, shown in `README.md`.
- What it is: an official illustration of the Harvest Sprites from the PlayStation game
  *Harvest Moon: Back to Nature* (Victor Interactive Software, 1999; English release by
  Natsume, 2000). The artwork is not original to this repository, and its copyright
  belongs to its respective owners. The repository's MIT license does not cover this file.
- Source: the Harvest Moon Wiki (Fandom), file `BTN_Sprites.jpg` (908 x 810 px, category
  "Back to Nature Character Pictures", credited there to Ranch Story), fetched
  2026-10-11 from
  https://harvestmoon.fandom.com/wiki/File:BTN_Sprites.jpg.
- Why not the wiki's per-sprite portraits: the files `Harvest Sprite <color> 1.png`
  (used on the `(BTN)` sprite pages) are categorized "HMDS Portraits", and the `Th_*.png`
  thumbnails are categorized "Friends of Mineral Town Portraits". They are not Back to
  Nature art, so they are not used. An earlier commit on this branch used them and was
  corrected on 2026-10-11.
- Modification: edge of the scan cropped (898 x 790 px), print texture smoothed with a
  vertical 1x5 convolution, enlarged 3x with Real-ESRGAN `realesr-animevideov3-x3`
  (realesrgan-ncnn-vulkan 20220424), then resized to 1796 x 1580 px and saved as JPEG
  quality 90 with no embedded metadata.
- Facts in the README (hut, hiring, birthdays, colors, affection and skill) come from
  https://www.harvestmoonbacktonatureguide.com/characters.html (PS1) and
  https://harvestmoon.fandom.com/wiki/Harvest_Sprites_(BTN).
- Removal: delete `docs/images/btn-harvest-sprites.jpg` and the image block in the
  "The Harvest Sprites" section of `README.md`.
