# NEXT — the baton

**Take: VF-005 — split `main.ts`.**

Why next: two sessions in a row added to the same file. `main.ts` is now 1514
lines and holds the frame pump, the mode switch, the HUD, the calibration flow,
the settings boot wiring and — since VF-004 — the error panel state machine
(`panelProblem`, `dismissed`, `setPanelProblem`, `dismissProblem`,
`fillInputHint`, `copyCommand`). Nothing else in Phase A is left, and every
Phase B ticket lands in this file. Split it before the interface rework, or
VF-010 will be written inside a god-file and thrown away.

## How

1. `scripts/agent-lock.sh start`
2. Read `docs/AGENT-CONTRACT.md`, this file, `docs/SHIP-PLAN.md` (Phase A), and
   the tail of `docs/PROGRESS.md`.
3. Extract, in this order, with **no behaviour change** — the diff should move
   code, not rewrite it:
   * `src/shell.ts` — DOM refs (the `const x = document.querySelector…` block),
     panels: error panel (`setPanelProblem`/`showError`/`hideError`/
     `dismissProblem`/`copyCommand`/`fillInputHint`), track hint, calibration
     panel, HUD (`setHud`).
   * `src/stream.ts` — `connect`, `pumpFrame`, `createFrameSource`, fps/frame
     accounting, the `frame-tick` listener.
   * `src/controls.ts` — keys, wheel, `setupFaceControls`, `setupGazeControls`,
     the mode subscription.
   * `src/hud.ts` — the status line text builder (`refreshStatus`'s string
     concatenation) as a **pure function** with unit tests: pass a status
     snapshot + mic/face/keys state, get the string back. This is the part worth
     testing and the part VF-011 replaces, so keep it tiny.
4. `main.ts` ends as boot + wiring, under 250 lines (it is 1514 today).
5. Keep `errors.ts` pure: `shell.ts` may import it, it may never import DOM.
6. `scripts/check.sh`, commit, rewrite this file, append `docs/PROGRESS.md`,
   `scripts/agent-lock.sh stop`.

## Notes from session 2 (VF-004)

* `showError(error, source)` takes `unknown` and classifies it; do not reintroduce
  `String(error)` at a call site. `source` is `"camera"` (default),
  `"face-camera"` or `"mic"` — the virtual camera and the webcam both say "busy"
  and the string cannot tell them apart.
* The panel now has **two** buttons: `#error-copy` (fix command) and
  `#error-dismiss`. `dismissed` is a `Set<ErrorCode>` that `applyModeUi` clears,
  `micProblem` clears when the mic goes live, and `connect` clears on retry. If
  the split keeps that state in module scope, the clearing sites must move with
  it or a dismissed error is silenced for the rest of the run.
* `setPanelProblem(null)` now covers the "camera recovered" case that `hideError()`
  used to handle inside `refreshStatus`; the `!status.running` branch still
  returns **without** clearing the panel (same as before — do not "fix" that
  here, it is VF-011's status bar that should own it).
* The error panel's DOM is `#error-title`, `#error-text`, `#error-fix`,
  `#error-fix-text`, `#error-copy`, `#retry`, `#error-dismiss`. `index.html`
  holds no error text of its own any more — that was the whole point.
* `inputHint` is filled once in `boot()` by `fillInputHint()` and only its
  `hidden` flag is polled. Its Copy button is the one element inside the hint
  with `pointer-events: auto`.
* `errors.ts` is the only place a device failure becomes words. Keep the
  `ErrorSource` argument when moving `refreshStatus`: the face-camera poll passes
  `"face-camera"`, the mic passes `"mic"`.

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
  Do not invent a second place for the device id.
* `cargo test --lib` has tests in `lib.rs` itself (`mod tests`); keep the
  temp-dir `Scratch` helper if you add file tests.

## Decisions open

* Store location: **settled** — the app config dir, one JSON file, Rust writes
  it (survives cache clears, inspectable, no plugin).
* `gstreamer_missing` exists in the taxonomy with no producer. Either the
  webview-capture fallback appears (a Phase C ticket) or the code should be
  dropped; do not wire it to a guess.
* The mic fix offers `systemctl --user restart wireplumber`, which was never run
  on this box. If a session ever sees a real denied mic, correct the command to
  what actually worked and update the README table.

## Found while working

* `hideError()` is now only called from `connect()`; the "device gone" path
  (writer thread died, `status.running` false) leaves a previous error panel up.
  That is VF-011's chip + VF-021's hotplug work, not a VF-004 bug.
* `virtual_camera.rs` really uses `VIICELL_VIDEO_DEVICE` (VF-004 checked), so the
  classifier matches `VIICELL_\w+=` rather than the exact name — keep that if
  Rust renames the variable.
* `src/mode.ts` still reads `VIICELL_MODE` at boot and ignores
  `settings.startMode`; the store has the field, nothing consumes it. The panel
  that sets it is VF-012 — decide there, not before.
* `window.width/height/x/y` are stored and validated, nothing reads or writes
  them; there is no window-state plugin and the contract forbids adding one
  without a ticket. Either a small ticket or drop the fields.
* `scripts/check.sh` still SKIPs the Windows compile gate (target not installed):
  every `#[cfg(windows)]` line is unverified.
* `bunx tsc --noEmit` and `bunx vite build` can be refused by the agent's
  command guard when run directly (it cannot scan the >1 MiB tsc entry script);
  `scripts/check.sh` runs them fine, so always gate through it.
