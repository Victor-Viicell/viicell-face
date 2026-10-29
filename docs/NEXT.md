# NEXT — the baton

**Take: VF-010 — layout shell.**

Why next: Phase A is closed (VF-003, VF-004, VF-005 all DONE). VF-010 is the
first Phase B ticket and the one every other Phase B ticket leans on: a stage +
docked panel is where the status chips (VF-011), the settings panel (VF-012) and
the onboarding wizard (VF-013) are supposed to land. Do it before any of them,
or they get written against the floating-panels layout and thrown away.

## How

1. `scripts/agent-lock.sh start`
2. Read `docs/AGENT-CONTRACT.md`, this file, `docs/SHIP-PLAN.md` (Phase B, first
   ticket), and the tail of `docs/PROGRESS.md` (session 3 = the split you are
   building on).
3. The layout work is in `index.html` + `src/styles.css` + the panel half of
   `src/shell.ts`. Everything else is already separated:
   * `src/shell.ts` — element ids and every panel painter. Add the panel
     container/toggle here; a new id goes in this file and nowhere else.
   * `src/stream.ts` — writes the HUD line via `shell.setHud` and repaints the
     attention marks; it must not learn about layout.
   * `src/main.ts` — boot + wiring, **under 250 lines** and **no
     `querySelector`**; `src/main.test.ts` fails the build if you break that.
     Wire the panel's collapse toggle from `wireButtons()`, not inline.
4. Acceptance is a size, so write the layout maths (letterbox rect for a given
   window, integer-ish scale, panel width, safe area) as a pure function with
   tests — `src/layout.ts` + `src/layout.test.ts` is the shape to copy from
   `src/hud.ts`: pure inputs, one output, no DOM. Then `shell` paints what the
   maths returned at 640×360, 1280×720 and 1920×1080.
5. `scripts/check.sh`, commit, rewrite this file, append `docs/PROGRESS.md`,
   `scripts/agent-lock.sh stop`.

## Notes from session 3 (VF-005)

* **The file map changed.** `main.ts` is 232 lines of boot and wiring;
  `shell.ts` (ids + painters), `hud.ts` (pure status line), `stream.ts` (frame
  path + poll), `controls.ts` (keys/wheel), `track_view.ts` (camera mode,
  crosshair, calibration). Look there before adding to `main.ts`.
* **The calibration flow lives in `src/track_view.ts`, not `main.ts`.** SHIP-PLAN
  still says "`src/main.ts` (calibration)" for VF-015 — that line is stale. The
  files for VF-015 are `src/track_view.ts` + `src/styles.css`.
* `dismissed` (the "this failure was waved away" set) is private to
  `src/shell.ts` now. Clearing it: `applyModeUi` does it itself, and `connect`
  calls `shell.clearDismissed()`; the mic's recovery calls
  `shell.forgetDismissed("mic_missing", "mic_denied")` from `micProblem()` in
  `stream.ts`. Do not move those calls away from the code paths they belong to.
* `shell.paintCalibration` takes six **finished strings**; the flow resolves
  them in `TrackView.renderCalibration`. Keep that direction: the painter must
  not decide anything, the flow must not know ids.
* `stream.installStream(isTauri, settings, sources)` must run before `connect()`
  or the first `refreshStatus()` — they throw a plain `Error` otherwise, on
  purpose, because a silent default would hide a wiring mistake. It is called in
  `boot()` just before `startStream`.
* `hud.statusLine(snapshot)` is pure and unit-tested against **whole strings**.
  VF-011 replaces it: keep the snapshot shape (it is the chip list, one field
  per chip) and delete the sentence when the chips land, rather than growing
  both.
* Element ids are a runtime null that `tsc` cannot see. Session 3 checked the 34
  ids the modules query against `index.html` by hand. If you rename one, grep
  `src/shell.ts` — it is the only file that should need the change.
* Nobody has run the window since VF-004. The whole boot → frame path is
  UNVERIFIED on a display; if you are the first session with a screen, run
  `bun run tauri dev` first and fix what it says before claiming VF-010.

## Notes from session 2 (VF-004, still true)

* `showError(error, source)` takes `unknown` and classifies it; do not
  reintroduce `String(error)` at a call site. `source` is `"camera"` (default),
  `"face-camera"` or `"mic"` — the virtual camera and the webcam both say "busy"
  and the string cannot tell them apart.
* The panel has two buttons: `#error-copy` (fix command) and `#error-dismiss`.
* `inputHint` is filled once in `boot()` by `fillInputHint()` and only its
  `hidden` flag is polled (`shell.setInputHint`). Its Copy button is the one
  element inside the hint with `pointer-events: auto`.
* `errors.ts` is the only place a device failure becomes words.
* `setPanelProblem(null)` covers "camera recovered"; the `!status.running` branch
  of `refreshStatus` still returns **without** clearing the panel (unchanged on
  purpose — VF-011's status bar should own it).

## Notes from session 1 (VF-003, still true)

* `settings.value("output")` is the one legal way to read the store. Do not edit
  `src/config.ts` numbers — they are `DEFAULT_SETTINGS.output`; a new output
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
* Panel width and collapse state want somewhere to live. VF-010 should use the
  VF-003 store (`Settings` + `DEFAULT_SETTINGS` + `mergeSettings` + README) for
  the remembered width, not `localStorage` — one store, one file.

## Found while working

* `src/shell.ts` is 309 lines of ids. That is fine today (one place to look), but
  VF-012 and VF-013 will each add a panel; the moment it passes ~450 lines, split
  it per panel (`shell/hud.ts`, `shell/error.ts`, `shell/calibration.ts`) rather
  than letting it grow into the next `main.ts`.
* `TrackView.calibrating` is the only thing `main.ts`/`controls.ts` ask the class
  about. If VF-015 needs more, add a getter — do not reach into `TrackView`'s
  private fields from outside.
* `refreshStatus` reads the microphone's state a moment later than VF-004 did
  (inside the `statusLine` call instead of before the tracking-camera poll). Same
  String, one poll later — harmless, but it is a real difference if a future
  session diffs the two versions.
* `scripts/check.sh` still SKIPs the Windows compile gate (target not installed):
  every `#[cfg(windows)]` line is unverified.
* `bunx tsc --noEmit` and `bunx vite build` can be refused by the agent's
  command guard when run directly; `scripts/check.sh` runs them fine, so always
  gate through it.
