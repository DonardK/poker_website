# Web copy, errors, and metadata

**Recorded:** 2026-10-10. Commit `7738c95`.

The web app was updated so play chips are not presented as money, and so missing routes and render failures have their own pages.

- Play-chip wording on the lobby, table, legal pages, and footer.
- Site metadata, icons, `robots.ts`, and `sitemap.ts` (`apps/web/src/lib/site.ts`).
- `error.tsx`, `global-error.tsx`, and `not-found.tsx`.
- Loading and accessibility adjustments on the table (turn clock, seats, dialogs).
- Browser specs for the table UI and table lifecycle were updated to match the copy.

This does not add payments, certification, or a change to the engine rules. Chip formatting that removed the "$" sign was already recorded as CR-010 on 7 October.
