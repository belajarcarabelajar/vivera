# The Vivera Farm Glossary

Vivera is the name this repository goes by. The pipeline underneath is
unchanged; the vocabulary around it borrows from *Harvest Moon: Back to
Nature* (Sony PlayStation, published in English in 2000), a farming game
about slow, patient work that pays off. The terms below are cosmetic labels
for real pipeline concepts. When a document says "ship it", "dispatch the
sprites", or "offer the Blue Feather", this is what it means.

| Farm term | In Back to Nature | In Vivera |
|---|---|---|
| The farm | The player's land in Mineral Village | This repository |
| Crops and seeds | What you plant, tend, and ship | Skills and their source files; `install.sh` plants them into every harness |
| Power Berry | A hidden berry that permanently raises max stamina by 10; ten of them exist | A permanent capability upgrade: each merged skill or tooling change raises what the pipeline can do in a day |
| Mystic Berry (Kappa's Berry) | Halves the fatigue rate; earned from Kappa after leaving three cucumbers in Mother Lake, one per spring day | Work that halves context fatigue: token frugality, graphify queries over raw dumps, `ctx_execute` over full output |
| The seven Harvest Sprites | Chef, Nappy, Hoggy, Aqua, Bold, Timid, and Staid, each in a different color | Subagents. Fan-out sends sprites to separate fields, and each sprite owns one small chunk |
| The Tea Party | A spring gathering held only when all seven sprites are home | The gather-and-synthesize checkpoint: reports are collected only when every dispatched sprite has reported |
| Affection (heart levels) | Seven colors from black to red, tracked in points (blue is 20,000 to 29,999; green is 30,000 to 39,999) | Trust, measured: review findings, fresh evidence, and merged work accumulate points; nothing is approved on vibes |
| Blue Feather | Sold at the Supermarket for 1,000G once a bachelorette reaches an orange heart; the marriage proposal item | A pull request. Opening one is the proposal, the owner's approval is the yes, and the merge is the wedding |
| Ores and Saibara's Forge | Mythril, Orichalcum, and Adamantite dug from the mine; Saibara forges Orichalcum into an accessory for 1,000G and a three-day wait | Raw contributions are ore. The REFACTOR pass and the review forge them into tools, and forging has a cooldown on purpose |
| The Shipping Bin and Zack | Produce goes in the bin and is collected and paid for each evening | The PR registry (`scripts/pr-registry.mjs`). Sessions toss verified work in, `order` computes the pickup route, and `merged` means shipped and paid |
| Won | The traveling peddler who shows up with rare goods | The optional-tools bazaar: tgrep, rtk, context-mode, snipset, graphify. Powerful, oddly priced, and strictly opt-in |
| House extensions and the Greenhouse | The farmhouse grows through extensions, and the greenhouse grows crops in any season | Repo maturity: each capability (templates, deep research, vault indexing, the graph) is a new wing. `graphify-out/` is the greenhouse: it grows in any codebase, in any season |
| Seasons | Spring, Summer, Fall, and Winter, thirty days each | The delivery lifecycle: Spring plants the idea (brainstorm), Summer tends the plan (design and approval), Fall brings the harvest (TDD, verification, PR), and Winter is for the hearth (debt sweep, ledger, memory) |
| Stamina and fatigue | Stamina drains as you work; at zero you pass out and lose the morning | The agent's context budget. Power Berries raise the ceiling, the Mystic Berry halves the burn, and compaction is passing out |
| Festivals | The town calendar: Goddess Festival, Harvest Festival, Fireworks Display, Starry Night | Release milestones; a new version may take a festival name |

## Naming

Vivera is a name the repository owner coined for this farm. It does not
appear in Harvest Moon: Back to Nature; it is the umbrella the
game-inspired vocabulary hangs under.

## Sources

Game facts above were checked against fan guides on 2026-10-03; rows backed
by a listed source are covered by it, and the rest (such as the thirty-day
seasons and the town names) are general game lore.

- Skyrender, The Hitchhiker's Guide to HM:BTN (https://www.skyrender.net/hmbtn_pb.html), fetched 2026-10-03: all ten Power Berry locations (+10 max stamina each) and the Mystic Berry ritual (three cucumbers into Mother Lake in spring, after noon).
- Harvest Moon Wiki (Fandom), search snippets for "Power Berry (BTN)", "Mystic Berry (BTN)", "Blue Feather (BTN)", and "Harvest Sprites (BTN)", accessed 2026-10-03: +10 stamina per berry; the Mystic Berry halves the fatigue rate; the Blue Feather is sold at the Supermarket for 1,000G at an orange heart; the seven sprites are Chef, Nappy, Hoggy, Aqua, Bold, Timid, and Staid.
- Ranch Story wiki, Items List (Harvest Moon: Back to Nature) (https://ranchstory.miraheze.org/wiki/Items_List_(Harvest_Moon:_Back_to_Nature)), accessed 2026-10-03: Mythril ore 40G, Orichalcum 50G, Adamantite 50G.
- GameFAQs, Harvest Moon: Back to Nature Guide and Walkthrough (faqs/10669, 2001-02-16), snippet: Saibara forges an Orichalcum accessory for 1,000G, ready after three days.
- Harvest Moon: Back to Nature Guide (https://www.harvestmoonbacktonatureguide.com/girls.html), accessed 2026-10-03: heart level affection point ranges (blue 20,000 to 29,999; green 30,000 to 39,999).
- Ushi No Tane forum, "Harvest Sprite Tea Party" (https://fogu.com/hmforum/viewtopic.php?t=174351), accessed 2026-10-03: the tea party requires all seven sprites at home.
