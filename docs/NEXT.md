# NEXT — the baton

**Take: VF-013 — first-run wizard.**

Why next: VF-012 is done, so the dock's settings rows exist and there is a panel
to reopen the wizard from. A fresh config with no loopback device still lands in
a dead canvas with an error panel that says "run sudo
scripts/setup-virtual-camera.sh" and nothing else — VF-013 turns that into four
steps with a current state, a reason and one button each.

## How

1. `scripts/agent-lock.sh start`
2. Read `docs/AGENT-CONTRACT.md`, this file, `docs/SHIP-PLAN.md` (Phase B,
   VF-013) and the tail of `docs/PROGRESS.md` (session 6 = the settings panel
   you are sitting under).
3. New `src/onboarding.ts`, split the way VF-012 split its work: the
   *decisions* (which step is the first missing one, what its button says, is
   the wizard done) in a pure module `bun test` can pin — **`bun test` has no
   DOM**, so a module that imports `shell.ts` cannot be tested at all; the DOM
   half asks `shell.ts` for its ids.
4. The four steps, in order: virtual camera present (`list_video_devices`, look
   for `isLoopback && canOutput`) → input permission (`keysAreGlobal()`) →
   microphone (`sources.mic()` in `stream.ts`, i.e. `SynthMouth.state`) →
   webcam (`VIICELL_FACE_DEVICE` / `list_video_devices`, since
   `face_camera::find_device` is only reachable through `faceCameraStatus()`
   once track mode is on). Each step: current state, what it is for, one button
   (`Copy` a fix from `errors.ts`, `Retry`, `Skip`). The fixes already exist —
   `inputDenied().fix`, the newly exported `MIC_FIX`, and the `no v4l2loopback
   device found` message from `virtual_camera.rs` — do not write a second copy
   of a command in the wizard.
5. Remember it in the store: a new `onboarded` boolean goes into `Settings`,
   `DEFAULT_SETTINGS`, `mergeSettings`, the full literal in `settings.test.ts`
   and the README table — that is the price of a new field, the store is
   validated field by field. Skipping must *stick*: `onboarded` is what makes
   the second boot land on the face, not the wizard.
6. Reopenable from the settings section (one more `.setting-row` is enough; do
   not grow `main.ts`, it is 242 of its 250 lines).
7. `scripts/check.sh`, commit, rewrite this file, append `docs/PROGRESS.md`,
   `scripts/agent-lock.sh stop`.

## Notes from session 6 (VF-012)

* **`stream.applyOutput(app, rig, settings)` is the size/rate path**:
  `renderer.resize` → `rig.setScale(width / ARTBOARD.width)` → `set_tick_rate` →
  `connect()`. It returns after the first two when `installStream` never ran, so
  the browser preview is safe; anything else that changes the output size must
  go through it rather than calling `connect()` alone.
* **`installSettingsPanel(settings, {reconnect, setOrigin})`** is installed in
  `boot()` *before* the `!isTauri` early return, so the preview has the panel
  (and the fold) too. It owns the fold toggle now; `main.wireButtons` does not.
* **The origin has one path**: `setupGazeControls` returns its `pick` (set the
  gaze + save it) and the panel's grid calls that. The status row's `origin`
  chip still reads `Gaze.label`; the grid paints from `settings.gazeOrigin`.
  They agree because both write through `pick` — a third way to set an origin
  must go through `pick` as well.
* **`shell.setSettingsBusy(busy)`** disables everything inside `#settings` and
  adds `.busy`. `connect()` paints `starting…` at the same moment, so the busy
  state shows twice on purpose (strip + controls).
* **`src/settings_view.ts` is the testable half**: presets, `parseSize` (even
  and clamped *before* the store, which clamps again), `panelView`. Put new
  control logic there, not in `settings_panel.ts`.
* The settings section is 186 px of the dock body at 320 px wide and the body
  already scrolls at 640×360 (569 vs 271 px). VF-013's wizard must be a dialog,
  not another section, or the body becomes a wall.
* **Only three keys are still groundwork**: `deviceId`, `cameraId`, `accent`.
  Do not add a control for one before the thing that reads it exists — that was
  this ticket's named trap.
* Five new ids were added in shell.ts (`#settings`, `#setting-size`,
  `#setting-fps`, `#setting-origin`, `#setting-start-track`); 43 queried, 0
  missing against index.html, re-checked with `comm`.

## Standing traps (older sessions, still true)

* **The layout is arithmetic + a paint, never CSS guesses.** `src/layout.ts`
  returns `{panel, stage, view, safe, content, unit}`; `shell.installLayout(() =>
  settings.value("panel"))` writes `--panel-width`, `--view-x/y/w/h` and the
  `folded` class, and repaints on `resize`. Ask `layoutFor`, never
  `getBoundingClientRect` at boot.
* **`Settings.panel` is the only place the fold lives** (`{width, collapsed}`,
  remembered in `settings.json`). `set()` deep-merges `panel`, so `{collapsed}`
  keeps a remembered width. No `localStorage`, no module copy. A width control
  has room in the settings section if a later ticket wants it: write the value,
  then `shell.relayout()`.
* **Chrome belongs in the dock**; `#stage` holds the canvas and nothing else.
  The overlays are deliberate: `#look-overlay`, `#calibration` (centred over the
  stage at `left: calc((100% - var(--panel-width)) / 2)`), `#error-panel`.
* **The camera preview docks in `#panel-body`** and is moved into the
  calibration dialog by `openCalibrationPanel`, prepended back by
  `closeCalibrationPanel`. A new panel that wants it must move it the same way.
* **`src/track_view.ts` owns the calibration flow**, not `main.ts` (SHIP-PLAN
  still says otherwise for VF-015 — that line is stale). `shell.paintCalibration`
  takes six **finished strings**; the flow decides, the painter never does.
* **`stream.installStream(isTauri, settings, sources)` must run before
  `connect()` / the first `refreshStatus()`** or they throw a plain `Error` on
  purpose. `dismissed` lives privately in `shell.ts`; `clearDismissed()` is
  called by `applyModeUi` and `connect`, and `micProblem()` calls
  `forgetDismissed("mic_missing", "mic_denied")` when the mic goes live — do not
  move those calls.
* **Element ids are a runtime null `tsc` cannot see.** Re-check them against
  `index.html` with `comm` after renaming one. `src/main.ts` also may hold no
  `querySelector` (`src/main.test.ts` enforces both that and the 250-line cap;
  it is 242 now).
* **`settings.value("output")` is the one legal read.** A new field goes into
  `Settings`, `DEFAULT_SETTINGS`, `mergeSettings`, the full literal in
  `settings.test.ts` and the README, in that order. Rust stores text only.
  `settings.set()` is debounced (250 ms); anything that must survive a quit calls
  `save()`/`flush()` (`beforeunload` does).
* **`showError(error, source)` takes `unknown`**; `source` is `"camera"`,
  `"face-camera"` or `"mic"`. `errors.ts` is the only place a failure becomes
  words. `setPanelProblem(null)` covers recovery; the `!status.running` branch of
  `refreshStatus` still returns without clearing the panel.
* **`bunx tsc --noEmit` / `bunx vite build` can be refused by the command guard**
  when run directly (read as watch processes); `scripts/check.sh` runs them fine,
  so always gate through it. `bun -e` is refused in a cron session (write a
  `.ts` file and run it instead).
* **The browser is how layout gets eyeballed**: `bunx vite preview --port 4173`
  + CDP for CSS and clicks, or `bunx vite --port 5173` and
  `await import('/src/shell.ts')` in the page to exercise the real modules.
  Note: an `await`-ing `Runtime.evaluate` with `setTimeout`s times out at ~5 s
  in this harness — drive each step with its own short `js()` call and
  `time.sleep()` between them. Kill the server before committing.

## Decisions open

* **The device picker is owed a Rust argument.** `list_video_devices` already
  returns every device with `isLoopback`/`canOutput`, but
  `start_camera(width, height, fps)` takes no device and `Camera::start` calls
  `find_device()` itself (`VIICELL_VIDEO_DEVICE` overrides). The session that
  wants it: `device: Option<String>` on `start_camera` (include it in the
  "already running, same format" early return), a
  `virtual_camera::start_on(path)` beside `start`, then the panel row. The
  webcam picker is the same shape, with `face_camera::start()` to open.
* **`accent` needs a paint entry point in `rig.ts`** before it gets a control:
  the pupils are built from `art.ts` fills at construction and only
  `#addPupilGlow`/`#applyPupil` touch them afterwards.
* `gstreamer_missing` exists in the taxonomy with no producer. Either the
  webview-capture fallback appears (Phase C) or the code should be dropped; do
  not wire it to a guess.
* The mic fix offers `systemctl --user restart wireplumber`, never run on this
  box. If a real denied mic is ever seen, correct the command and the README.
* `body.looking` hides the dock but the stage keeps `right: var(--panel-width)`,
  so fullscreen is not re-centred for the pupil run. VF-015 decides.
* VF-013's webcam step has no cheap probe (see How §4): comparing
  `VIICELL_FACE_DEVICE` with `list_video_devices` costs no new command and is
  honest enough for "is there a camera at all"; a real `list_cameras` is the
  better answer if the step ends up needing device names.
* `docs/SHIP-PLAN.md` Phase A still describes `main.ts` as the calibration
  entry point; the flow lives in `src/track_view.ts`.

## Found while working

* A panel size change resizes the canvas **buffer** immediately; the
  letterboxed **view** keeps its CSS box (`layout.ts` owns that, about the CSS
  box, not the buffer). Sharp, but worth one sentence in the README if anyone
  asks why the face did not grow.
* The status row's `device` chip reports what the writer measured, so it is one
  poll behind after a size change. It agrees within a second; leave it.
* `#debug-row`, `#look-row` and `#lean-row` are lit through `shell.setRowActive`;
  the guide scrolls now, so a lit row can be out of sight. VF-014's overlay
  should keep the lit state.
* The browser preview calls `wireButtons()` before `installStream`; the retry
  button would reject if it were reachable there. Either guard `connect()` on
  "stream installed" or skip that button in preview.
* `scripts/check.sh` still SKIPs the Windows compile gate (target not
  installed): every `#[cfg(windows)]` line is unverified.
* `connect()`'s success line is a message, not chips, because `startCamera`
  echoes what was *asked for* rather than what the writer measured. If the
  restart makes that line flicker, the fix is to paint chips optimistically from
  `info` with `fps` marked as "target", not to slow the poll.
