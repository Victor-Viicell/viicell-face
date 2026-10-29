# NEXT — the baton

**Take: VF-003 — settings store.**

Why first: every other UI ticket needs one place to read/write state, and the
app currently forgets everything on restart (the single biggest "alpha feel"
tell). Do not touch the layout yet.

## How

1. `scripts/agent-lock.sh start`
2. Read `docs/AGENT-CONTRACT.md`, this file, `docs/SHIP-PLAN.md` (Phase A), and
   the tail of `docs/PROGRESS.md`.
3. Build `src/settings.ts`: a plain, framework-free store — defaults, deep
   merge, version field, `load()`/`save()` behind an injectable adapter so the
   tests never touch Tauri, one debounced write. Fields should cover what the
   app already knows (`src/config.ts` OUTPUT), plus: device id, camera id, gaze
   origin, accent, start mode, window size/position.
4. Wire the smallest possible use: on boot, read the persisted output config;
   on change, save. Do **not** build the settings panel (that is VF-012).
5. `scripts/check.sh`, commit, rewrite this file, append `docs/PROGRESS.md`,
   `scripts/agent-lock.sh stop`.

## Notes from session 0

* `src/config.ts` is 31 lines and holds the output config — it should become a
  consumer of the store, not a second source of truth (failure bank #53).
* Rust side has no config file yet; if you need the app config dir, Tauri 2
  exposes `app.path().app_config_dir()`. Do not add a settings plugin.
* The frame path is hot. A store read per frame is fine **only** if it is a
  field access on a cached object — no JSON, no localStorage, no async.
* `bun test` globs `**/*.test.ts`; keep tests pure (no DOM, no Tauri).

## Decisions open

* Store location: app config dir vs. the webview's localStorage. Leaning to the
  app config dir (survives cache clears, readable by Rust, one file to inspect).

## Found while working

(nothing yet)
