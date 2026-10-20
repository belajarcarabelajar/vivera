# Other repositories

> Part of the rule handbook indexed in [MEMORY.md](../../MEMORY.md). Rule IDs are global and never reused.

| # | Rule (`WHEN <situation> → DO <action>, NOT <anti-pattern>`) | Origin session |
|---|---|---|
| L68 | WHEN a plan task writes to a production surface (store, checkout, DNS, email routing) → DO re-read who serves it (DNS, Worker routes, custom domains) right before planning the write, NOT rely on research from earlier in the day (measured: the public checkout moved from Berdu to a bcb Worker at 06:10 UTC the same day, and most of a session was planned against Berdu) | vivera-workshop (PR #112) |
| L70 | WHEN a store or admin action has a repository write path (a repo function plus the platform API) → DO use that path with a dry run first, NOT drive the admin UI with browser automation (measured: a TinyFish run on the Berdu admin stopped at its safety check after 151 steps; `createProductsRepo` plus one D1 REST batch created both products and read them back) | vivera-workshop (PR #112) |
| L71 | WHEN a migration changes fixture data in another repository's tests → DO `rg` for every caller of the migration runner that builds a fixture database and prove the fix in the suite's own process, NOT in a helper that starts its own server (measured: bcb `dev-db.ts` was fixed and proved with `compare.ts`, while `freshProdukDb()` built a second fixture inside the e2e process; one 35-minute gate failed on it) | vivera-workshop (PR #112) |
| L72 | WHEN a sprite contract names a test command in bcb → DO copy the unit-only paths from `check:terarah` (for example `bun test apps/vivera/src apps/vivera/scripts`), NOT a directory that also holds an e2e suite (measured: `bun test apps/vivera` also ran `apps/vivera/e2e/vivera.test.ts`, which launched headless Chromium twice outside `/tmp/bcb-chromium.lock` on the shared machine) | vivera-workshop (PR #112) |
