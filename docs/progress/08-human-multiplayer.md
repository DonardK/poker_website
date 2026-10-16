# Human multiplayer and migration recovery

**Recorded:** 2026-09-28

New tables are human-only. A missing audit-column migration had been freezing live hands; startup now refuses a database that cannot settle.

The text below is preserved from the root `progress.md` entry for this work. Later files in this folder supersede it where they conflict. Start at [the progress index](README.md).

---

## 2026-09-28 - restore live games and switch new tables to human multiplayer

- **Root cause:** The running server used a Prisma schema with five hand-audit columns that OnlinePoker did not have. At settlement, `Hand.handUuid` caused a `P2022` database error, so turns retried and games looked frozen. Applied the existing additive compliance migration to OnlinePoker, recorded it in both Supabase and Prisma migration histories, and aligned the Supabase migration filename with its recorded version. A previously stalled table then recorded its next two hands and returned to WAITING. Startup now checks the required columns and fails with a migration instruction instead of accepting games that cannot settle.
- **Human tables:** New standard and custom tables contain only human seats. The server rejects bot creation requests and keeps legacy bot tables visible only to players still seated at them. The lobby explains that two people must sit before a hand starts; the table has a clear waiting message and a copy-link control. Custom tables can be named. Creation returns to the table immediately after the server confirms it, even if the separate bankroll refresh is slow.
- **Verification:** A live, two-account game on the connected server created a custom two-seat table, appeared in the other player's lobby, dealt private cards correctly, advanced through a complete hand, served a participant audit, and cashed both players out with chip totals conserved. The exact temporary table and accounts were removed afterwards. Server tests passed (35, one existing OpenSSL-dependent skip), all 14 desktop/mobile browser checks passed, typecheck and the full production build passed, and localhost web/API both returned HTTP 200.
- **Further validation:** Multiplayer under concurrent load, cross-device disconnects, and deployed-domain socket/TLS behavior still need dedicated testing. The live test used localhost and play chips.
