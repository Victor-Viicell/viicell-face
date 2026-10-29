# NEXT — the baton

**Take: VF-014 — shortcut overlay.**

Why next: the dock still carries the whole key map (`aside#guide`, 14 rows and 3
notes) in the scrolling body, and at 640×360 that is most of what a person
scrolls past to reach the calibration buttons. VF-013 finished the first-run
steps, so the dock's job is now "the things you change" — the full key list
belongs on `F1`/`?`, grouped by task, showing only the keys valid in the current
mode, with one hero hint left visible.

## How

1. `scripts/agent-lock.sh start`
2. Read `docs/AGENT-CONTRACT.md`, this file, `docs/SHIP-PLAN.md` (Phase B,
   VF-014) and the tail of `docs/PROGRESS.md` (session 7 = the wizard, whose
   dialog pattern you can copy: a `.wizard`-shaped box over the stage, ids in
   `shell.ts`, decisions in a pure module).
3. New `src/keymap.ts`: the rows as data — `{keys, what, group, mode?}` — and
   `keymapFor(mode)` returning the groups that apply, so `bun test` pins "which
   keys exist in which mode" without a DOM. `index.html` keeps an empty
   `#keymap` container; the painter rebuilds it once per open, not per frame.
4. `src/controls.ts` owns the keys: `F1` and `?` toggle the overlay, `Esc`
   closes it. Watch the modifier rule — every key is behind a mouse side button
   (`input.ts` `subscribeInput`) — so the toggle must arrive through the same
   stream, and `?` is `shift`+`/` on most layouts; accept the literal
   `?` event key, not a keycode.
5. Keep one hero hint in the dock: "hold a side button" stays visible when the
   overlay is closed, or nobody discovers the keys at all.
6. The overlay is DOM over the stage (`#keymap`, `z-index` between the wizard's
   6 and the calibration's 5), never in the canvas: it must not leak into the
   frames other apps capture — `createFrameSource` hides the skeleton overlay
   for exactly this reason, and a DOM box is outside the readback already.
7. `scripts/check.sh`, commit, rewrite this file, append `docs/PROGRESS.md`,
   `scripts/agent-lock.sh stop`.

## Notes from session 7 (VF-013)

* **`src/onboarding.ts` is the testable half** (facts → steps), **`src/onboarding_panel.ts`
  the wiring** (one probe, one paint). Same split as
  `settings_view.ts`/`settings_panel.ts`: put rules in the first, listeners in
  the second.
* **A fix is never written twice.** `errors.ts` owns every command;
  `deviceMissing()` and `inputDenied()` exist so a surface can name a failure
  before it happens. If the overlay needs a command, take it from there.
* **`shell.setWizardOpen(true)` mutes `setPanelProblem` entirely** (early return,
  and the panel is cleared on open). The wizard therefore reports the writer's
  refusal *inside* its own camera row via `cameraFailure`. Any new dialog that
  covers the stage should claim the same flag, or the panel will paint behind
  it — there is exactly one flag, not one per dialog.
* **`shell.copyText(text, button)`** is the clipboard path (async API, textarea
  fallback, `Copied`/`Copy failed` for 1.2 s). `copyErrorFix`/`copyInputFix` are
  thin wrappers over it.
* **`main.ts` is 247 of its 250 lines.** The next thing that wants a line in
  `boot()` has to split something out first (the `!isTauri` preview branch and
  `wireButtons` are the two obvious candidates). Do not raise the cap in
  `src/main.test.ts`.
* **The wizard is installed only under Tauri** (`if (isTauri) installWizard(...)`),
  because `list_video_devices` is the only probe and it cannot answer in the
  browser. A side effect: the dock's `setup` row does nothing in the preview.
  Worth fixing if anything else in the dock is dead there too.
* **`keysAreGlobal()` is false for the first moments of a run** (`startInput()`
  opens the devices asynchronously), so a wizard opened immediately says "keys
  only work while this window has focus" until `Check again`.
* The wizard's rows **wrap** their state line instead of ellipsising
  (`.wizard-step-state`): at 640×360 the box is 288 px and "found /dev/video10
  (Upright Camera)" would otherwise end in "…".

## Standing traps (older sessions, still true)

* **The layout is arithmetic + a paint, never CSS guesses.** `src/layout.ts`
  returns `{panel, stage, view, safe, content, unit}`; `shell.installLayout(() =>
  settings.value("panel"))` writes `--panel-width`, `--view-x/y/w/h` and the
  `folded` class, and repaints on `resize`. Ask `layoutFor`, never
  `getBoundingClientRect` at boot.
* **`Settings.panel` is the only place the fold lives** (`{width, collapsed}`,
  remembered in `settings.json`). `set()` deep-merges `panel`. No `localStorage`,
  no module copy.
* **Chrome belongs in the dock**; `#stage` holds the canvas and nothing else.
  The overlays are deliberate: `#look-overlay`, `#calibration`, `#wizard`,
  `#error-panel`.
* **The camera preview docks in `#panel-body`** and is moved into the
  calibration dialog by `openCalibrationPanel`, prepended back by
  `closeCalibrationPanel`.
* **`src/track_view.ts` owns the calibration flow**, not `main.ts` (SHIP-PLAN's
  VF-015 line is stale).
* **`stream.installStream(isTauri, settings, sources)` must run before
  `connect()` / the first `refreshStatus()`** or they throw a plain `Error` on
  purpose. `dismissed` lives privately in `shell.ts`; `clearDismissed()` is
  called by `applyModeUi` and `connect`, and `micProblem()` calls
  `forgetDismissed("mic_missing", "mic_denied")` when the mic goes live.
* **Element ids are a runtime null `tsc` cannot see.** Re-check against
  `index.html` with `comm` after renaming one — 49 queried, 0 missing as of
  session 7. `src/main.ts` may hold no `querySelector` (`src/main.test.ts`).
* **A new `Settings` field costs five edits**: the interface, `DEFAULT_SETTINGS`,
  `mergeSettings`, the full literal in `settings.test.ts` and the README. Rust
  stores text only. `settings.set()` is debounced (250 ms).
* **`showError(error, source)` takes `unknown`**; `errors.ts` is the only place a
  failure becomes words. `setPanelProblem(null)` covers recovery; the
  `!status.running` branch of `refreshStatus` returns without clearing the panel.
* **`bunx tsc --noEmit` / `bunx vite build` can be refused by the command guard**
  when run directly; `scripts/check.sh` runs them fine. `bun -e` is refused in a
  cron session.
* **The browser is how layout gets eyeballed**: `bunx vite --port 5173` (start it
  with `background=true`, the guard refuses it in the foreground), then
  `await import('/src/<module>.ts')` in the page to drive the real modules; a
  `window.__TAURI_INTERNALS__ = {invoke: ...}` stub is enough to fake
  `list_video_devices`/`camera_status`. Kill the server before committing.
* `bun test` has no DOM: a module that imports `shell.ts` cannot be tested at
  all.

## Decisions open

* **The device picker is owed a Rust argument.** `list_video_devices` returns
  every device with `isLoopback`/`canOutput`, but `start_camera(width, height,
  fps)` takes no device and `Camera::start` calls `find_device()` itself
  (`VIICELL_VIDEO_DEVICE` overrides). The session that wants it: `device:
  Option<String>` on `start_camera` (include it in the "already running, same
  format" early return), a `virtual_camera::start_on(path)` beside `start`, then
  the panel row. The webcam picker is the same shape, with `face_camera::start()`.
* **`VIICELL_FACE_DEVICE` is invisible to the webview**, so the wizard's webcam
  row can only say "a capture node exists". A `face_device` command (or a field
  on `list_video_devices`) would let it name the pinned node and tell "pinned but
  unusable" apart from "none".
* **`accent` needs a paint entry point in `rig.ts`** before it gets a control.
* `gstreamer_missing` exists in the taxonomy with no producer. Either the
  webview-capture fallback appears (Phase C) or the code should be dropped.
* The mic fix offers `systemctl --user restart wireplumber`, never run on this
  box.
* `body.looking` hides the dock but the stage keeps `right: var(--panel-width)`,
  so fullscreen is not re-centred for the pupil run. VF-015 decides.

## Found while working

* The `setup` row in the settings section does nothing in the browser preview
  (the wizard is Tauri-only). Either guard it on "wizard installed" or install
  the wizard everywhere and let it report `unknown` rows.
* `#wizard` and `.calibration` are both fixed dialog boxes over the stage; if a
  calibration could ever start while the wizard is up they would stack. Nothing
  does today (`installWizard` runs before the stream, and calibration needs the
  camera).
* The wizard counts `readyCount` and shows `n/4`; a `degraded` step still pauses
  the eye even though it is optional. If the first-run feels nagging, the fix is
  to count `ready` + `degraded` as "seen".
* `scripts/check.sh` still SKIPs the Windows compile gate (target not
  installed): every `#[cfg(windows)]` line is unverified.
* A panel size change resizes the canvas **buffer** immediately; the letterboxed
  **view** keeps its CSS box.
