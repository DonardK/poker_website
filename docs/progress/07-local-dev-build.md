# Separate Next.js build directories

**Recorded:** 2026-09-28

Development, production, and browser tests no longer share one `.next` directory.

The text below is preserved from the root `progress.md` entry for this work. Later files in this folder supersede it where they conflict. Start at [the progress index](README.md).

---

## 2026-09-28 - localhost startup 500 after a production build

- Reproduced `Internal Server Error` from `http://localhost:3000` while the API health endpoint remained healthy. The running Next.js development server and a later production build had written to the same `.next` directory.
- Next.js development now writes to `.next-dev`; production builds keep `.next`, and isolated browser tests keep `.next-browser-test`. The new dev output is ignored by Git and included in web typechecking.
- Verified the running localhost page recovered to HTTP 200 after the config reload and stayed HTTP 200 during a successful production web build. Web typechecking passed.
