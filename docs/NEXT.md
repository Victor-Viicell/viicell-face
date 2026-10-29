# NEXT — the baton

**Take: VF-011 — status bar.**

Why next: VF-010 is done and the dock now has a foot (`#hud`, `#input-hint`,
`#track-hint` stacked in `.dock-foot`) where the status line lives. VF-011
replaces the one long sentence there with a row of chips, and every chip needs a
documented source — which is the whole ticket. Doing it before VF-012 means the
settings panel is written under a status area that already has its final shape.

## How

1. `scripts/agent-lock.sh start`
2. Read `docs/AGENT-CONTRACT.md`, this file, `docs/SHIP-PLAN.md` (Phase B,
   VF-011), and the tail of `docs/PROGRESS.md` (session 4 = the layout you are
   building on).
3. The snapshot is already the chip list — `src/stream.ts` calls
   `shell.setHud(state, hud.statusLine(snapshot))` once a second with
   `{mode, device, format, fps, in/dropped, eyes, keys, mic, face, lowLightGain}`.
   Keep that shape: `src/hud.ts` should turn it into an array of chips
   (`{key, label, state: "ok"|"warn"|"off", tooltip}`), pure and unit tested, and
   `src/shell.ts` should paint them into `#hud`. **Delete `statusLine`** rather
   than keeping both — VF-010's `docs/NEXT.md` said so and the tests in
   `src/hud.test.ts` pin whole strings, so they get rewritten with it.
4. The chips have to fit a 295 px foot (320 px column, 12 px padding). `.dock-foot`
   is a flex column; give `#hud` `flex-wrap: wrap`. A chip is `<span class="chip"
   data-state="warn" title="<the fix>">`. Colour comes from `data-state` in
   `styles.css`, not from inline styles.
5. `#hud-text` is referenced by the fold CSS in `body.folded #hud-text {
   display: none }` — if the id goes, move the rule to the chip container or a
   folded dock loses its dot-only state. `#hud`'s own `data-state` attribute is
   set by `shell.setHud` today and `setPanelProblem` uses `setHud("error", …)`
   to put the failure headline there: keep a way for the error panel to own the
   state (a single "error" chip or the container's `data-state`) before you
   delete the sentence.
6. `scripts/check.sh`, commit, rewrite this file, append `docs/PROGRESS.md`,
   `scripts/agent-lock.sh stop`.

## Notes from session 4 (VF-010)

* **The layout is arithmetic + a paint, never CSS guesses.** `src/layout.ts`
  returns `{panel, stage, view, safe, content, unit}` for a window size and a
  panel state; `shell.installLayout(() => settings.value("panel"))` writes
  `--panel-width`, `--view-x/y/w/h` and the `folded` body class, and repaints on
  `resize`. Anything that needs to know where something is asks `layoutFor`,
  not `getBoundingClientRect` at boot.
* **`Settings.panel` (`{width, collapsed}`) is the only place the fold lives.**
  It is remembered in `settings.json` through the VF-003 store. `set()`
  deep-merges `panel`, so a `{collapsed}` patch keeps a remembered width —
  there is a test for it. Do not add a second copy (no `localStorage`, no
  module variable).
* **Chrome belongs in the dock.** `#stage` holds the canvas and nothing else.
  Overlays are the exception and are deliberate: `#look-overlay` (fullscreen
  gaze crosshair), `#calibration` (the run dialog, now centred over the stage at
  `left: calc((100% - var(--panel-width)) / 2)`), `#error-panel` (modal).
* **The camera preview docks in `#panel-body`** and is moved into the
  calibration dialog by `openCalibrationPanel` and prepended back by
  `closeCalibrationPanel`. If a new panel wants it, move it back the same way.
* **The browser preview now calls `wireButtons()`** before it returns, so the
  fold can be exercised in a plain browser. That means the retry button exists
  with no stream installed: clicking it would reject out of `connect()` (the
  panel is hidden in preview, so it cannot be clicked today).
* `src/main.ts` is 243 of its 250 lines. The next session that needs wiring room
  should split something out (the settings adapter is 8 lines) rather than raise
  the number — `src/main.test.ts` enforces it.
* A full `Settings` literal in `src/settings.test.ts` has to gain every new
  field; adding a setting means editing that literal (it type-checks against
  `Settings`, so tsc catches it).

## Notes from session 3 (VF-005, still true)

* **The calibration flow lives in `src/track_view.ts`, not `main.ts`.** SHIP-PLAN
  still says "`src/main.ts` (calibration)" for VF-015 — that line is stale. The
  files for VF-015 are `src/track_view.ts` + `src/styles.css`.
* `dismissed` (the "this failure was waved away" set) is private to
  `src/shell.ts`. Clearing it: `applyModeUi` does it itself, and `connect` calls
  `shell.clearDismissed()`; the mic's recovery calls
  `shell.forgetDismissed("mic_missing", "mic_denied")` from `micProblem()` in
  `stream.ts`. Do not move those calls away from the code paths they belong to.
* `shell.paintCalibration` takes six **finished strings**; the flow resolves
  them in `TrackView.renderCalibration`. Keep that direction: the painter must
  not decide anything, the flow must not know ids.
* `stream.installStream(isTauri, settings, sources)` must run before `connect()`
  or the first `refreshStatus()` — they throw a plain `Error` otherwise, on
  purpose, because a silent default would hide a wiring mistake.
* Element ids are a runtime null that `tsc` cannot see. Session 4 checked the 37
  ids `shell.ts` queries against `index.html` with `comm`; do the same if you
  rename one.
* Nobody has run the window under Tauri since VF-004. Session 4 verified the
  *layout* in Chromium against `vite preview`, which is not the same thing: the
  boot → frame path is still UNVERIFIED on a display. If you are the first
  session with a screen, run `bun run tauri dev` first.

## Notes from session 2 (VF-004, still true)

* `showError(error, source)` takes `unknown` and classifies it; do not
  reintroduce `String(error)` at a call site. `source` is `"camera"` (default),
  `"face-camera"` or `"mic"` — the virtual camera and the webcam both say "busy"
  and the string cannot tell them apart.
* The error panel has two buttons: `#error-copy` (fix command) and
  `#error-dismiss`.
* `inputHint` is filled once in `boot()` by `fillInputHint()` and only its
  `hidden` flag is polled (`shell.setInputHint`). Its Copy button is the one
  element inside the hint with `pointer-events: auto`.
* `errors.ts` is the only place a device failure becomes words.
* `setPanelProblem(null)` covers "camera recovered"; the `!status.running` branch
  of `refreshStatus` still returns **without** clearing the panel (unchanged on
  purpose — VF-011's status bar should own it).

## Notes from session 1 (VF-003, still true)

* `settings.value("output")` is the one legal way to read the store. A new output
  field goes in `Settings`, `DEFAULT_SETTINGS`, `mergeSettings` and the README,
  in that order.
* The settings file is `<app config dir>/settings.json`, written by
  `read_settings`/`write_settings` in `src-tauri/src/lib.rs`. Rust stores text
  only: a new field never needs a Rust change.
* `settings.set()` is debounced (250 ms); anything that must survive a quit calls
  `save()`/`flush()`, and `beforeunload` already does.
* Nothing reads `deviceId`, `cameraId`, `accent`, `startMode` or `window.*` yet.
  `src/mode.ts` still reads `VIICELL_MODE` at boot and ignores
  `settings.startMode` — VF-012 decides that, not before.

## Decisions open

* `gstreamer_missing` exists in the taxonomy with no producer. Either the
  webview-capture fallback appears (a Phase C ticket) or the code should be
  dropped; do not wire it to a guess.
* The mic fix offers `systemctl --user restart wireplumber`, which was never run
  on this box. If a session ever sees a real denied mic, correct the command to
  what actually worked and update the README table.
* The dock's width is stored but nothing resizes it yet: VF-012 owns a drag
  handle / width control. `layout.ts` already clamps whatever it is given, so
  VF-012 only has to write the value and call `shell.relayout()`.
* `body.looking` hides the dock but the stage keeps `right: var(--panel-width)`,
  so in fullscreen the face is not re-centred for the pupil run. VF-015 should
  decide whether looking mode re-lays-out the stage or leaves it.
* At a 360 px-tall window the dock body scrolls (14 key rows do not fit). VF-014
  removes the key map from the dock, which fixes it; if it lands elsewhere, add
  a `@media (max-height: …)` compaction instead.

## Found while working

* `shell.setHud(state, text)` is called from four places in `stream.ts` and from
  `setPanelProblem`; when the chips land, the painter and its four call sites
  should change in one commit or the HUD will show two statuses.
* `#debug-row`, `#look-row` and `#lean-row` are highlighted through
  `shell.setRowActive`; the guide is inside a scrolling body now, so a
  highlighted row can be scrolled out of sight. VF-014's overlay should keep the
  lit state.
* The browser preview calls `wireButtons()` before `installStream`; the retry
  button would reject if it were reachable there. Either guard `connect()` on
  "stream installed" or skip that button in preview.
* `scripts/check.sh` still SKIPs the Windows compile gate (target not
  installed): every `#[cfg(windows)]` line is unverified.
* `bunx tsc --noEmit` and `bunx vite build` can be refused by the agent's
  command guard when run directly (it reads them as watch processes);
  `scripts/check.sh` runs them fine, so always gate through it.
