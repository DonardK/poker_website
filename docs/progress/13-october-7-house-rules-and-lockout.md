# House rules, local database, and login lockout

**Recorded:** 2026-10-07 (night)

The "fix now" list. Auto-muck (NEW-3), pausing a broken table (CR-004), and password reset by email were left open. The preserved text says the rest was uncommitted. That was true this night. It was committed on 8 October 2026 (`d490b13`) and merged to `main` on 10 October.

The text below is preserved from the root `progress.md` entry for this work. Later files in this folder supersede it where they conflict. Start at [the progress index](README.md).

---

## 2026-10-07 (night) - "Fix now" list from the session log, section 8

**Status: stopped here for this session.**
- **Done:** items 1, 2, 3, 6 and 7 (except password reset by e-mail), and most of 4 and 5.
- **Left for a dedicated session:**
  - auto-muck in the engine (NEW-3; the House Rules are kept);
  - CR-004 (pause a broken table; operator void and refund);
  - password reset (needs an e-mail provider).
- **Not committed:** everything after the item 1 commits. The auto-mode safety check began blocking git commands right after those commits; [7 October session log](../reviews/2026-10-07-session-log.md) section 9 has the commit commands for the owner.
- **Standard:** this is real-money online poker for players worldwide, with the company in Malta, held to the highest standard. The code is made to meet the published rules; the rules are never lowered.

**Final check (all suites, after the last change):**

| Suite | Result |
| --- | --- |
| Typecheck | 4/4 |
| Engine, as CI runs it | 430/430 (was 458/477 with 19 failures) |
| Server | 136/136 |
| Ledger | 21/21 |
| `test:db` | 44/44, 9 migrations |
| End to end on a real PostgreSQL | Pass |
| Browser | 155/156, then 40/40 for the spec file after the flaky test was fixed |

Every change is listed in [7 October session log](../reviews/2026-10-07-session-log.md) section 9.3.

| # | Item | Status | Verified by |
| --- | --- | --- | --- |
| 1 | Commit the work on a branch | **Done (local only, not pushed).** Branch `fix-now-2026-10-07` holds 5 commits: engine and shared, server and database, web, CI/deploy/docs/tooling (all the uncommitted work from 24 Sep – 6 Oct, committed unchanged and split by area), then the reviews and logs. The 7 Oct evening fixes and everything below are not committed yet. `apps/web/next-env.d.ts` is left out on purpose (the dev server rewrites it). Not pushed: it is the client's repository, and it now contains security reviews | Commit list in the tool output |
| 3 | Get CI green | **Done (uncommitted).** Engine: `review-fixes.test.ts` now records what the shared check does with each forgery (19 money forgeries rejected, 10 outcome forgeries still pass it, 6 unchecked), replacing the outdated "card integrity always passes" assertion. Database: new migration `20261007200000_table_incident_column_grants` (with its Supabase copy) narrows TableIncident UPDATE to `resolvedAt`/`resolvedBy`; the privilege test lists TableIncident and its column grant, and a new test proves incidents can be resolved but not rewritten or deleted | Engine `review-fixes.test.ts` 94/94; `test:db` 44/44 (was 41/43). **Also:** the browser guest sign-up test (`shell-legal.spec.ts`) now resets the fixture server to "unseated" first, like the other tests. Before, the fixture's default seated hero (9,000 chips) made the "10,000 chips" check race the lobby's wallet refresh, and it failed 3 times tonight on desktop. That spec file then passed 40/40 |
| 2 | Develop against a local database (development machines only; the live site stays online on the production database) | **Done (uncommitted).**<ul><li>New `npm run dev:local` (`scripts/dev-local.mjs`): keeps a PostgreSQL of its own in `.local-db/` (git-ignored), with the same embedded binaries as `test:db`, every migration applied and a local `poker_server` login, then runs `npm run dev` against it. `.env` and the shared database are never touched.</li><li>Options: `-- --db` (database only, prints its URLs), `-- --check` and `-- --reset`.</li><li>The game server now warns at start-up in development when `DATABASE_URL` is not local.</li><li>README updated.</li></ul> | `dev:local --check` run twice: the first run created the cluster and applied all 9 migrations; the second reused it. The runtime login works as `poker_server`. The test copy was deleted afterwards; startup and config tests 13/13 |
| 4 | Make the published House Rules true (the code must meet the rules; the rules are not lowered) | **Partly done (uncommitted).**<ul><li>**Personal time bank (NEW-2):** new tables get the configured bank (30 s, +5 s per 10 hands, max 60 s); the server times turns, bot moves and late actions by `turnDeadline` (base time + bank).</li><li>**Fresh clock after a restart (F10):** `recover()` applies `rebaseTurnClock`, so the player to act gets a fresh base time and the hand records a TURN_CLOCK_RESET audit event.</li><li>**Bot switch (NEW-5):** `ENABLE_LEGACY_BOTS` now works (off by default, as documented): with it off a bot's turn times out like an absent player's.</li><li>A rules-text change I made for auto-muck was **reverted** at the owner's instruction (the House Rules keep auto-muck, as top real-money sites do); `rules/page.tsx` and `shell-legal.spec.ts` are back to the committed text.</li></ul>**Not done:** auto-muck of losing hands in the engine (NEW-3). It changes the showdown in `settle()` and both audit verifiers (with old records kept valid), so it is planned as its own fully tested change | Lifecycle tests 31/31, including 2 new tests (time bank timing, bots off by default) and the restart test updated to expect the fresh clock (its recorded hand still verifies); server suite (below) |
| 5 | Fix the ways chips can be trapped or lost | **Partly done (uncommitted).**<ul><li>**CR-033:** the SHOWDOWN timer now commits Hand Clean-up (cash-outs, released seats) on its own, then deals the next hand as a separate command, so a failed deal can no longer undo payouts; timing is unchanged.</li><li>**F09:** a human's cash-out whose bankroll update touches no row now rolls back the whole commit (the seat keeps its chips); a bot's cash-out still credits nothing, by design.</li></ul>**Not done:** CR-004 (pause a table that cannot load or settle, plus an operator void and refund). It is the largest item and is left for later | New `apps/server/test/hand-cleanup.test.mjs` (3 tests, including an RNG outage during the next deal); the compliance static scan was updated for the new cash-out check; server suite 133/133 |
| 6 | One schema for client and server | **Done (uncommitted).** Every socket schema in `apps/server/src/socket/index.ts` is now a named constant, and a compile-time contract check requires each one to accept exactly the payload type the web client is typed against (`packages/shared/src/events.ts`): same keys (optional ones included) and mutually assignable. A field added on one side only, the NEW-1 shape, now fails the typecheck. Chosen over moving zod into the shared package, which would need a new dependency | Server typecheck passes with all six payloads matching; a scratch file with a one-sided optional field fails with TS2322 as intended; socket, auth-socket and game-flow tests 22/22 |
| 7 | Replace the hard login lockout | **Done except password reset (uncommitted).** Smart lockout (`apps/server/src/auth/smart-lockout.ts`, wired in `auth/routes.ts` login): the account-wide lock now applies only to addresses the account has never signed in from. An address one of its sessions used in the last 90 days (IPv6 by /56, like the rate limiter) is familiar, and the owner signing in from it is not locked out by others' guesses. Failures from a familiar address lock that address only, on the same 30 s to 15 min schedule; they are counted in memory, per instance, like the other limiters. Every attempt does the same work (one session lookup and one bcrypt comparison), and every refusal is the same 401. New security log events: familiar-address lockout, and sign-in from a familiar address during a lock. **Not done:** password reset by e-mail, which needs an e-mail provider (owner decision) | New test in `auth-http.test.mjs`; the existing lockout test passes unchanged; server suite 136/136 |
