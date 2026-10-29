# Progress log

Newest entry last. One entry per session, written by the session that did the
work, appended before it lets go of the lock. Keep it to facts: ticket, what
changed, what was verified and how, what was NOT verified.

---

## 2026-10-29 — session 0 (setup, by the owner's agent)

* **VF-001 / VF-002 done**: repo hygiene + the rotating-session machinery.
  * `docs/AGENT-CONTRACT.md` — the standing rules for every session.
  * `docs/SHIP-PLAN.md` — 40 tickets across 6 phases + a 58-item failure bank.
  * `docs/NEXT.md` — the baton (rewritten by every session).
  * `scripts/check.sh` — the one gate before a commit (tsc, bun test, vite
    build, cargo test, cargo check, windows target when installed).
  * `scripts/agent-lock.sh` — single-writer guard, 75 min staleness (a dead
    session frees the lock after one tick rather than blocking the rotation).
  * `scripts/agent-status.sh` — cheap context for the hourly tick.
* Baseline measured on this machine: bun 1.4.4, node 26, rustc 1.99, all 167 TS
  tests pass, `tsc --noEmit` clean, `cargo check` clean, v4l2loopback present as
  `/dev/video10` ("Upright Camera"), webcam at `/dev/video0`.
* Known gaps at alpha: no Windows/Android code paths at all (every native module
  is unconditionally Linux), no settings persistence, `main.ts` is 1322 lines of
  ad-hoc DOM, CSP is `null`, `withGlobalTauri` is on, the UI floats five panels
  over the canvas.
* The alpha working tree was committed as a checkpoint before any rework
  (`alpha snapshot`), so every later session's diff is readable.

## 2026-10-29 — session 1 — VF-003 settings store

* **Changed**: `src/settings.ts` (+ `src/settings.test.ts`) — the store: typed
  `Settings` (version, output w/h/fps, deviceId, cameraId, gazeOrigin, accent,
  startMode, window w/h/x/y), `DEFAULT_SETTINGS`, `mergeSettings` (unknown keys
  dropped, every field validated on its own, sizes rounded even and clamped to
  160–1920 / 90–1080, fps 1–120, accent `#rrggbb`, origin/mode whitelisted),
  `parseSettings` (corrupt/empty ⇒ defaults), `serializeSettings` (stable text),
  and `SettingsStore` with `load/set/save/flush/subscribe/dispose` and one
  debounced write behind an injectable `SettingsAdapter`.
  `src-tauri/src/lib.rs` — `read_settings`/`write_settings` commands over
  `<app config dir>/settings.json`, JSON-validated and renamed into place from
  `settings.json.tmp`; both registered in `generate_handler!`.
  `src/main.ts` — store built at module scope (Tauri adapter, `null` in the
  browser preview), `boot()` awaits `load()` *before* Pixi init and drives
  canvas size, rig scale, `set_tick_rate` and `connect()`/`startCamera` from it;
  the gaze origin is restored at boot and saved when picked with `0`+`1`–`5`.
  `src/config.ts` — `OUTPUT` is now `DEFAULT_SETTINGS.output` (defaults have one
  home). `README.md` — "Changing the output" rewritten for the settings file,
  "Eye tracking" notes the origin is remembered.
* **Verified**: `scripts/check.sh` → CHECK GREEN (tsc clean; `bun test` 193 pass
  across 10 files, 26 of them new; `vite build` ok; `cargo test --lib` 21 passed
  + 1 ignored, 6 new ones covering the file path in a temp dir; `cargo check`
  ok). Windows compile gate still SKIP (no target installed).
* **Not verified**: the live path — boot read, and a key-press save surviving a
  restart. Both need a display, so no session has run the app. Also unverified:
  the settings path on Windows/Android (`app_config_dir` untested there), and
  whether the window keeps any position between runs (nothing reads
  `window.*` yet).
