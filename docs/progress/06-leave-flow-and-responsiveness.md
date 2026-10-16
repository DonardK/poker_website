# Leave flow and responsiveness

**Recorded:** 2026-09-28

Leaving a table, action acknowledgements, and a latency pass on seat writes and broadcasts.

The text below is preserved from the root `progress.md` entry for this work. Later files in this folder supersede it where they conflict. Start at [the progress index](README.md).

---

## 2026-09-28 - leave flow, action responsiveness, and regression coverage

- **Leaving:** Both table leave controls now wait for a server acknowledgement and return to the lobby. A separate lobby link always remains available when disconnected and clearly says the seat stays reserved. A player still in a hand sees a clear pending cash-out; a player not dealt into that hand can cash out immediately. Repeated requests cannot pay twice. The lobby keeps a pending notice until settlement and receives the updated bankroll even after leaving the table room. The lobby also includes the player's own seat when its table falls outside the newest 50 public tables.
- **Actions and recovery:** Actions receive explicit success/error acknowledgements, can be retried after rejection, and cannot silently queue while disconnected. Ordinary API requests have a timeout; session refresh is exempt so a timed-out cookie rotation cannot invalidate the next attempt. Temporary refresh failures no longer clear a valid session. The table timer cannot be overwritten by stale recovery and retries transient recovery-read failures.
- **Latency:** The server skips seat writes for unchanged seats (one changed seat instead of all six in the call regression), avoids seat/user relation loading for encrypted table states, checks private-table membership only when needed, stops autojoining a table socket from the lobby, and broadcasts viewer-specific snapshots concurrently. Bot think times remain intentionally paced; measure end-to-end latency against the deployment database before claiming a production millisecond improvement.
- **Verification:** New engine, server, and isolated desktop/mobile browser regressions cover pending leave, immediate un-dealt cash-out, wallet settlement, stale-wallet fetches and refreshes, idempotence, rollback, action retry, disconnect behavior, and timer recovery. Typecheck, production build, and the full test suite (408 engine tests; server tests pass with one existing OpenSSL-dependent skip) passed. All 12 Chrome browser checks passed; the disconnected-lobby scenario also passed again on desktop and mobile after the fallback link was added. The browser suite runs outside the restricted Windows sandbox so it can shut down its test servers cleanly.
- **Still to validate:** A two-human live play session, production database latency under load, long disconnects and expiry across multiple devices, and a deploy smoke test. No production tables or balances were modified in this pass.
