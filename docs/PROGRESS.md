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

## 2026-10-29 — session 4 — VF-010 layout shell

* **Changed**: the window is two columns now. `index.html` grew `#panel` (a
  `.dock` aside: head with `#panel-toggle`, body with the camera preview, the
  calibration presets and the key map, foot with `#hud`, `#input-hint` and
  `#track-hint`). Nothing chrome-ish is a child of the body any more except the
  look overlay, the calibration dialog and the error panel, which are overlays
  on purpose.
  * `src/layout.ts` (new, 181) — `layoutFor(window, {width, collapsed})` returns
    `panel`, `stage`, `view`, `safe`, `content` and the whole-number `unit`;
    `panelColumn` caps the column at 42% of the usable width, floors it at 240
    px and 200 px of content; `letterbox` gives the largest 16×9·k centred in
    an area; `safeArea` insets the canvas by 6% of its short side. No DOM, no
    timer, one output.
  * `src/layout.test.ts` (new, 157) — 29 tests, the acceptance sizes as
    `describe`s: view inside the stage, never under the panel, `16·unit ×
    9·unit`, safe area inside the view and disjoint from panel/content, content
    ≥ 200 px, fold grows the stage and the view, 1000×1000 keeps 16:9, a
    remembered width is clamped both ways, 120×90 and 0×0 do not go negative.
  * `src/settings.ts` — `PanelSettings` (`width`, `collapsed`), `LIMITS.panel`
    (240–420), `DEFAULT_SETTINGS.panel` (320, open), merging + `SettingsPatch`
    + the partial merge inside `set()` so `{collapsed}` cannot reset a
    remembered width. `src/settings.test.ts` — 3 new: clamp/reject-non-boolean
    at merge level, and a fold→reload round trip through the store.
  * `src/shell.ts` (349) — `panelToggle`, `panelBody`, `installLayout(state)`
    (paints `--panel-width`, `--view-x/y/w/h`, the `folded` body class and
    `aria-expanded`, repaints on `resize`) and `relayout()`;
    `closeCalibrationPanel` now prepends the preview back into the dock.
  * `src/styles.css` — `#stage` is `inset: 0 var(--panel-width) 0 0`, `#output`
    is absolutely placed at the painted rect, `.dock`/`.dock-head`/`.dock-body`
    (scrolling)/`.dock-foot`, `body.folded` hides the body and the title and
    leaves the toggle plus a dot-only HUD. HUD, hints, guide and presets lost
    their `position: fixed` and their blurs; the calibration dialog centres over
    the stage instead of the bottom of the window.
  * `src/main.ts` (243) — one line installs the layout
    (`installLayout(() => settings.value("panel"))`); `wireButtons()` grew the
    fold handler (store first, then `relayout()`), and the browser preview calls
    `wireButtons()` too, so the fold is testable without Tauri.
  * `README.md` — new "The window" section, `layout.ts` in the file map, and the
    four sentences that still said "bottom-left HUD" / "side panels step out of
    the way" / "hint above the HUD" corrected.
* **Verified**: `scripts/check.sh` → CHECK GREEN (`tsc --noEmit`; `bun test`
  261 pass across 14 files, 31 new; `vite build`; `cargo test --lib`; `cargo
  check`). Windows gate still SKIP. **And, for the first time since VF-004, the
  layout was looked at in a real Chromium**: `vite preview` + CDP at 640×360,
  1280×720, 1920×1080 and 1000×1000 — view 352×198, 928×522, 1568×882,
  656×369 (all 16·k × 9·k), every chrome rect inside the panel column, no
  overlap with the canvas; the fold took the column 320→44 px and the view
  928×522→1200×675, `aria-expanded` true→false, second click restored it
  exactly. A screenshot at 1280×720 shows the letterboxed face left and the
  dock right with nothing over the canvas.
* **Not verified**: `bun run tauri dev` was still not run — the browser preview
  has no Tauri bridge, so nothing here proves the frame pump still reaches
  `/dev/video10` at the new size (the pump is untouched, but that is an argument,
  not a measurement). Also unverified on a real X11/Wayland window: the dock at
  a 640×360 *window* (only the browser viewport was resized) and the calibration
  dialog at its new centred position. At 640×360 the dock body scrolls (271 px
  visible of 438): 14 key rows cannot fit in 360 px, so the key map scrolls
  rather than being clipped by anything — VF-014 removes it anyway.

## 2026-10-29 — session 5 — VF-011 status bar

* **Changed**: the one long status sentence at the foot of the dock is a row of
  eight chips, one per fact, each with its own state and tooltip.
  * `src/hud.ts` (rewritten, 305) — `statusLine()` **deleted**;
    `statusChips(snapshot)` returns `Chip[]` (`{key, label, state, tooltip}`) in
    a fixed order: mode, device, fps, dropped, mic, face, keys, origin. `ChipKey`
    is a union so `shell.ts` keys its nodes by it and a typo is a type error.
    Thresholds: `FPS_WARN_BELOW = 20` (below that a call stutters); drops are a
    warning at > 0; everything else is a device state, not a number.
  * Tooltips are the documented source or the fix, and the fixes are imported:
    `inputDenied().fix` for `keys window` and the newly exported `MIC_FIX` for
    `mic off` — `src/errors.ts` is still the only place a command lives.
  * `src/shell.ts` (404) — `setHudChips(chips)` paints the row into
    `#hud-chips`, reusing one node per key and writing text/state/title only
    when they changed; `hud.dataset.state` is the worst chip's, and `HudState`
    gained `warn` so the folded dot goes yellow. `setHud(state, text)` keeps the
    one-line slot (cold start, camera stopped, backend unreachable, preview,
    failure headline), hides the row, and now sets the line's `title` because
    the sentence ellipsises in 295 px.
  * `src/stream.ts` — the poll calls `setHudChips(statusChips({…}))`;
    `connect()`'s success line stays a message on purpose (it echoes what was
    *asked for*, `startCamera`'s own reply, not what the writer measured).
  * `index.html` — `#hud-chips` inside `#hud`, after `#hud-text`.
  * `src/styles.css` — `#hud-chips` wraps (`flex: 1`, `min-width: 0`, gap 3×4);
    `.chip` is a 11 px monospace pill with `tabular-nums`, colour from
    `[data-state]` (green/yellow/grey), `pointer-events: auto` + `cursor: help`
    so the `title` fires (`.hud` still swallows the pointer otherwise).
    `body.folded` now hides `#hud-chips` beside `#hud-text`.
  * `README.md` — new "The status row" section: a table of every chip with the
    place its number comes from, plus the wrapping/keyed-repaint/folded-dot
    rules; five old quotes (`eyes camera·top left`, `eyes cursor·monitor`,
    `lift ×N`, "under the HUD", "status line") now name the chip they live in.
* **Verified**: `scripts/check.sh` → CHECK GREEN (`tsc --noEmit`; `bun test`
  276 pass across 14 files — `src/hud.test.ts` rewritten, 25 tests, +15 net;
  `vite build`; `cargo test --lib`; `cargo check`). Windows gate still SKIP.
  Geometry measured in Chromium against `vite preview` with the real chip
  labels: 1280×720 and 1920×1080 → 295 px foot, 3 rows, 78 px tall, widest chip
  197 px, 0 chips past the hud's edge; 640×360 → 234 px foot, 5 rows, 124 px
  tall, still 0 overflow; folded → row and line both `display: none`, hud 19×26,
  dot `rgb(249,226,175)` with `data-state="warn"`. The painter itself was
  exercised through `vite` dev by importing the real modules into the page
  (`await import('/src/shell.ts')`): 8 chips with the expected labels/states,
  the first node identical after a repaint (12 fps → `12 fps`+`warn`,
  `0 dropped`+`ok`), all eight `title`s set, `setHud("error", …)` hiding the row
  and showing the line (clipped, as before — hence the new title), the next
  `setHudChips` restoring the row. Shell's 38 queried ids were re-checked
  against `index.html` with `comm` (0 missing).
* **Not verified**: nothing was run under `bun run tauri dev` — the chip row has
  never been seen with a real backend behind it, and `camera_status`'s live
  numbers were simulated, not measured. Tooltips were checked as attributes,
  not as rendered popups (no hover in a headless measurement). At 640×360 the
  foot is now 124 px of a 360 px window: that is the key map's problem
  (VF-014 removes it), but if the strip ever needs to be shorter, the device
  chip (197 px, size + format) is the one to split.

## 2026-10-29 — session 6 — VF-012 settings panel

* **Changed**: the dock has a **settings** section, bound to the store VF-003
  built, with four controls that all round-trip and survive a restart.
  * `src/settings_view.ts` (new, 190) — the panel's decisions without a DOM:
    `OUTPUT_PRESETS` (1920×1080 / 1280×720 / 960×540 / 640×360, all 16:9 because
    the artboard is scaled by width), `FPS_PRESETS` (60/30/24/15),
    `outputChoices` / `fpsChoices` (a saved value that is not a preset gets its
    own entry first, so the control never lies), `parseSize` (accepts the
    `1280×720` label, rounds to even and clamps to `LIMITS.output` **before**
    the store sees it), `originChoices` (built from `GAZE_ANCHORS`, so the grid
    and the keys cover the same five points) and `panelView` (size label, fps,
    origin, start-in-track — read from `Settings`, never from `Gaze`).
  * `src/settings_panel.ts` (new, 140) — `installSettingsPanel(settings,
    {reconnect, setOrigin})`: one `paint(settings)` driven by `subscribe`, the
    fold toggle (moved out of `main.ts`), and `restart()` which writes, sets
    `shell.setSettingsBusy(true)`, awaits `reconnect`, and only then re-enables.
  * `src/stream.ts` — `applyOutput(app, rig, settings)`: `renderer.resize` →
    `rig.setScale(width / ARTBOARD.width)` → `set_tick_rate` → `connect()`, in
    that order; four things have to agree or frames of the wrong length go out.
    Returns after the first two when `installStream` was never called (browser
    preview has no ticker and no writer, and `connect()` would throw there).
  * `src/face/rig.ts` — `setScale(scale)`, the one number a size change needs
    from the rig.
  * `src/controls.ts` — `setupGazeControls` now **returns** its `pick`, so the
    panel's origin grid and the `0`/`1`–`5` keys are the same path.
  * `src/shell.ts` — five new ids (`#settings`, `#setting-size`, `#setting-fps`,
    `#setting-origin`, `#setting-start-track`) and `setSettingsBusy(busy)`
    (`.busy` on the section + `disabled` on every control inside it).
  * `index.html` / `src/styles.css` — the section above the key map: two
    selects, a 2×2+centre origin grid (built in JS from the shared anchor list),
    a checkbox; `.setting-row` is the same 78 px label column the key map uses.
  * `src/main.ts` (242, was 243) — installs the panel before the preview branch
    and lets the setting decide the start mode: `(await startupFaceMode()) ??
    settings.value("startMode")`.
  * `README.md` — "Changing the output" is now a table of the four rows and when
    each applies, the busy state, and the three keys that are still groundwork;
    the dock description and the module table name the two new files.
* **Verified**: `scripts/check.sh` → CHECK GREEN (`tsc --noEmit`; `bun test`
  292 pass / 15 files — `src/settings_view.test.ts` is new, 16 tests, covering
  the presets, the extra saved entry, odd/out-of-range parsing, the store clamp
  behind it, the grid vs `GAZE_ANCHORS`, and `panelView` round-tripping through
  `parseSize`; `vite build`; `cargo test --lib`; `cargo check`). Windows gate
  still SKIP. In Chromium against `vite preview`, driven over CDP: the size
  select lists the four presets with `1280×720` selected and the rate lists
  60/30/24/15 with `30`; setting size to `640×360` took `#output` from
  1280×720 to 640×360 with its CSS box unchanged at 448 px, controls re-enabled
  and `.busy` cleared; the origin grid showed five buttons with `centre` active
  and `aria-pressed`, clicking `bottomRight` moved the active mark; the
  start-in-track checkbox went false→true→false with the paint following; the
  fold still folds to 44 px and back to 320 px with the grid's mark intact.
  At 640×360 the section is 186 px tall, the body scrolls (569 vs 271 px) and
  nothing overflows horizontally — no clipped button (`scrollWidth ==
  clientWidth` on all five) and no clipped select.
* **Not verified**: the restart against a real v4l2 device — no backend in a
  headless session, so `applyOutput`'s `set_tick_rate` + `connect()` path and
  `start_camera`'s teardown at a new size were never executed, and the browser
  preview returns before them by design. `rig.setScale` was only exercised as
  `root.scale.set` in the preview (the face is not drawn there without WebGL
  readback). The panel's persistence across a real quit depends on the debounced
  write landing — `beforeunload` still calls `settings.save()`.
