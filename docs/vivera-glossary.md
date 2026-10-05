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
| The seven Harvest Sprites | Chef, Nappy, Hoggy, Aqua, Bold, Timid, and Staid, each in a different color; they live in the hut behind the church and are hired for 1, 3, or 7 days once raised to 3 hearts | Subagents. Fan-out sends sprites to separate fields, and each sprite owns one small chunk |
| Watering (menyiram) | One of the three farm jobs: ask a sprite to water crops; skill is tracked per job and rises by 1 per task; trained by the watering follow-the-leader minigame | Keep-alive work: rebase the session branch, rerun checks, keep in-progress crops alive until harvest |
| Animal Care (merawat) | One of the three farm jobs: ask a sprite to feed and brush animals; same 1/3/7 day request and 3-heart rule; trained by the chicken-feeding minigame | Long-lived assets: templates, the graph, the vault index, and docs that live across seasons, not one harvest |
| Harvesting (memanen) | One of the three farm jobs: ask a sprite to harvest ripe crops; same request rules; guides advise keeping at least one sprite on harvest | Shipping: gather reports, verify with fresh evidence, toss into the shipping bin (`scripts/pr-registry.mjs`), and propose the Blue Feather |
| Sprite dispatch affinity | Convention, not game fact: in BTN any sprite can do any of the three jobs. Default affinity only: Aqua and Bold to watering, Hoggy and Chef to harvesting, Nappy Timid and Staid to animal care; skill stays tracked per job as in the game | Dispatch default for fan-out: water-affinity sprites take keep-alive chunks, harvest-affinity sprites take gather-and-ship chunks, care-affinity sprites take long-lived asset chunks. The parent may reassign any sprite to any chunk |
| The Tea Party | A spring gathering held only when all seven sprites are home | The gather-and-synthesize checkpoint: reports are collected only when every dispatched sprite has reported |
| Affection (heart levels) | Seven colors black, purple, blue, green, yellow, orange, red (black 0 to 4,999; blue 20,000 to 29,999; green 30,000 to 39,999; max 65,535, bright red at 60,000); sprites separately need 3 hearts before they work, and sprite hearts rise per 25 affection points | Trust, measured: black to blue is an unverified claim, green to yellow is evidenced work, orange opens the Blue Feather proposal, red is the merged wedding; no sprite report counts before the parent audit gate, the 3-heart rule for subagents |
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

Game facts above were checked against fan guides on 2026-10-03 and 2026-10-04; rows backed
by a listed source are covered by it, and the rest (such as the thirty-day
seasons and the town names) are general game lore.

- Skyrender, The Hitchhiker's Guide to HM:BTN (https://www.skyrender.net/hmbtn_pb.html), fetched 2026-10-03: all ten Power Berry locations (+10 max stamina each) and the Mystic Berry ritual (three cucumbers into Mother Lake in spring, after noon).
- Harvest Moon Wiki (Fandom), search snippets for "Power Berry (BTN)", "Mystic Berry (BTN)", "Blue Feather (BTN)", and "Harvest Sprites (BTN)", accessed 2026-10-03: +10 stamina per berry; the Mystic Berry halves the fatigue rate; the Blue Feather is sold at the Supermarket for 1,000G at an orange heart; the seven sprites are Chef, Nappy, Hoggy, Aqua, Bold, Timid, and Staid.
- Ranch Story wiki, Items List (Harvest Moon: Back to Nature) (https://ranchstory.miraheze.org/wiki/Items_List_(Harvest_Moon:_Back_to_Nature)), accessed 2026-10-03: Mythril ore 40G, Orichalcum 50G, Adamantite 50G.
- GameFAQs, Harvest Moon: Back to Nature Guide and Walkthrough (faqs/10669, 2001-02-16), snippet: Saibara forges an Orichalcum accessory for 1,000G, ready after three days.
- Harvest Moon: Back to Nature Guide (https://www.harvestmoonbacktonatureguide.com/girls.html), accessed 2026-10-03: heart level affection point ranges (blue 20,000 to 29,999; green 30,000 to 39,999).
- Ushi No Tane forum, "Harvest Sprite Tea Party" (https://fogu.com/hmforum/viewtopic.php?t=174351), accessed 2026-10-03: the tea party requires all seven sprites at home.
- Ushi No Tane, Characters Harvest Sprites (https://fogu.com/hm4/peeps/sprites.htm), fetched 2026-10-04: hut behind the church; three jobs (water crops, harvest crops, take care of animals); Chef red, Nappy orange, Hoggy yellow, Timid green, Aqua blue, Bold violet; 1/3/7 day requests from the next morning; 3 hearts required; color grass gifts; three training minigames (watering follow-the-leader, turnip pull, chicken feed). Note: this source lists Staid as indigo, while Ranch Story lists Staid as green and a fan blog lists Staid as dark blue, so the table above stays at "a different color" for Staid and per-sprite colors outside the fogu list are not asserted.
- Harvest Moon Wiki (Fandom), "Harvest Sprites (BTN)" search snippets, accessed 2026-10-04: hired for watering crops, harvesting crops, and animal care; one job per sprite per day; hidden skill level per job starts at 0 and rises by 1 per task; the seven colors span the rainbow (red, orange, yellow, green, blue, purple, indigo).
- Harvest Moon: Back to Nature Guide, Girls page (https://www.harvestmoonbacktonatureguide.com/girls.html), rechecked 2026-10-04: seven heart levels with point bands (black 0 to 4,999; blue 20,000 to 29,999); GameFAQs calendar guide: max affection 65,535 with bright red at 60,000; scribd affection guide snippet: sprite hearts rise per 25 affection points with per-job skill max 255.
