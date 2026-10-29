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

## 2026-10-29 — session 2 — VF-004 error taxonomy

* **Changed**: `src/errors.ts` (+ `src/errors.test.ts`) — `AppError { code,
  message, detail, fix? }`, `ErrorCode` (device_missing, device_busy,
  device_invalid, device_denied, camera_missing, camera_busy, camera_denied,
  mic_missing, mic_denied, format_unsupported, input_denied,
  gstreamer_missing, backend_unreachable, unknown), and `classify(error,
  source)` — an ordered rule table over the regexes of the sentences
  `src-tauri/src/{virtual_camera,face_camera,microphone}.rs` actually send. An
  optional `source` ("camera" | "face-camera" | "mic" | "input") separates the
  virtual camera's "busy" from the webcam's, which the strings cannot. Already
  classified errors pass through, so double classification is lossless.
  `inputDenied()` is the udev/input case the app knows without a string.
  `index.html` — the panel is now `#error-title` + `#error-text` + `#error-fix`
  (`code#error-fix-text` + Copy) + Try again / Dismiss; the input hint gained
  its own text/code/Copy nodes. `src/main.ts` — `showError(unknown, source)` is
  the only entry point; `setPanelProblem` holds one error slot, dedupes by
  code+detail so the one-second poll cannot repaint, and `dismissed` (a
  Set<ErrorCode>) suppresses a dismissed code until that device recovers or the
  mode changes. The tracking camera's failure is promoted into the panel from
  `beginTracking` (rejected start) and `refreshStatus` (`faceProblem`), which
  outranks `micProblem()`. `copyCommand` uses `navigator.clipboard` and falls
  back to a hidden textarea + `execCommand`. `src/styles.css` —
  `.error-fix`, `.panel-actions`, `.input-hint button` (the hint keeps
  `pointer-events: none` for everything but that button). `README.md` — new
  "When a device fails" section with the code→command table, and `errors.ts`
  added to the file map.
* **Rust untouched on purpose**: the ticket said classify, not rewrite, so the
  taxonomy lives in exactly one place.
* **Verified**: `scripts/check.sh` → CHECK GREEN (`tsc --noEmit` clean;
  `bun test` 218 pass across 11 files, 25 of them new in `errors.test.ts`;
  `vite build` ok; `cargo test --lib` and `cargo check` unchanged and ok).
  Windows compile gate still SKIP (no target installed).
* **Not verified**: everything visual — no display in this session, so the panel
  layout, the Copy button inside the WebKitGTK webview (is `navigator.clipboard`
  available there, or does it always fall through to `execCommand`?) and the
  dismissal behaviour are unproven. Also unproven: that restarting the user
  PipeWire service actually restores a denied microphone on this box — it is the
  standard remedy for "the device is there but will not open", not something
  measured here. `gstreamer_missing` has no producer today (nothing in the app
  calls `getUserMedia`); the code exists so the webview capture path has a home.

## 2026-10-29 — session 3 — VF-005 split `main.ts`

* **Changed**: `main.ts` went from 1514 to 232 lines. The move, in files that
  name what they are (same code, same strings, same event order — no behaviour
  change):
  * `src/shell.ts` (309) — every element id, and the panels that read them: HUD
    (`setHud`), mode row (`applyModeUi`, which also clears the dismissed set —
    the state stayed next to its clearing sites), error panel
    (`setPanelProblem`/`showError`/`hideError`/`dismissProblem`/`copyErrorFix`/
    `copyInputFix`/`fillInputHint`) with `dismissed` private to the module plus
    `clearDismissed()`/`forgetDismissed(...)`, track hint, calibration panel
    (`paintCalibration` takes six finished strings; `openCalibrationPanel`/
    `closeCalibrationPanel` also move the preview canvas in and out), row
    highlights, the `looking` body class, and the one `LookOverlay` instance.
  * `src/hud.ts` (90) — `statusLine(snapshot)`: the status sentence as a pure
    function over `{mode, device, format, fps, in/dropped, eyes, keys, mic,
    face, lowLightGain}`. It appends the low-light lift only in tracking mode,
    and says `face ?` without a lift when the poll itself failed.
  * `src/stream.ts` (286) — `installStream(isTauri, settings, sources)`,
    `startStream` (ticker stop, `set_tick_rate`, frame-tick listener),
    `connect`, the unchanged `pumpFrame`/`createFrameSource`, and
    `refreshStatus` (the one-second poll, the attention marks, `micProblem`).
    The pump is byte-for-byte the old one, still allocation-free.
  * `src/controls.ts` (583) — `setupFaceControls(app, rig, hooks)` with the
    whole key/wheel/blink/size table, and `setupGazeControls(gaze, settings)`.
    The two things it cannot own (`R` → calibrate, `T` → preview, `G` →
    crosshair, and "is the panel open") come in as `FaceControlHooks`.
  * `src/track_view.ts` (456) — `TrackView`: camera mode as a class. Owns the
    tracking pull (`pump`), `begin`/`enter`/`leave`, the track hint text, the
    full-monitor crosshair and its fullscreen dance, and the calibration flow
    (`startCalibration`/`renderCalibration`/`advanceCalibration`/
    `closeCalibration`) with all of its panel state.
  * `src/main.ts` — boot, the singletons (`settings`, `gaze`, `tracker`,
    `lowLight`, `tracking`, `mouth`, `cameraDebug`, `trackView`), the mode
    subscription, the ticker callback, `wireButtons()`, `beforeunload`.
  * `src/main.test.ts` (new) — fails if `main.ts` passes 250 lines or looks up
    an element, so the split cannot be undone by the next session.
  * `README.md` — the file map lists the five new modules and `main.ts` is
    described as boot + wiring; the backdrop paragraph credits `stream.ts` for
    advancing the clock.
* **Decision**: the calibration flow lives in `track_view.ts`, not `main.ts`.
  Boot alone is ~120 lines and calibration another 137, so VF-015's "rework
  `src/main.ts` (calibration)" cannot coexist with a 250-line main.ts. VF-010
  and VF-015 should treat `src/track_view.ts` + `src/styles.css` as the files.
* **Verified**: `scripts/check.sh` → CHECK GREEN (`tsc --noEmit` clean;
  `bun test` 230 pass across 13 files — 10 new in `hud.test.ts` pinning whole
  status strings, 2 in `main.test.ts`; `vite build` ok; `cargo test --lib` and
  `cargo check` ok). Windows compile gate still SKIP (no target installed).
  The ids the new modules query were checked against `index.html` by hand (all
  34 present), because a wrong id is a runtime null that `tsc` cannot see.
* **Not verified**: the app itself was never launched — no display in this
  session. So "frames still flow" rests on `vite build` plus the pump being an
  unchanged function, not on a frame reaching `/dev/video10`. The first session
  with a screen must run `bun run tauri dev` and confirm: a live HUD line, a
  camera that starts on retry, `T`/`G`/`Z`+wheel still posing, and a mouth
  calibration that opens and closes the panel with the preview inside it.
