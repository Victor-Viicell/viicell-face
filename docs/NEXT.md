# NEXT — the baton

**Take: VF-004 — error taxonomy.**

Why next: VF-003 gave the app a memory; it still talks to the user in raw Rust
strings (`showError(String(error))` in `main.ts`, `status.error` from the camera
status poll). Every device failure — missing loopback device, busy webcam, denied
mic, missing udev rule — currently lands in the same generic panel. VF-004 is what
turns "it does not work" into "run this".

## How

1. `scripts/agent-lock.sh start`
2. Read `docs/AGENT-CONTRACT.md`, this file, `docs/SHIP-PLAN.md` (Phase A), and
   the tail of `docs/PROGRESS.md`.
3. `src/errors.ts`: one `AppError { code, message, detail, fix? }`, a table of
   codes (device_missing, device_busy, camera_busy, mic_denied, input_denied,
   udev_rule, gstreamer_missing, …), and `classify(error)` that maps a Rust
   `String`/the status payloads into one. Keep it pure and unit-tested
   (`src/errors.test.ts`) — no DOM.
4. Wire it: `main.ts` `showError` takes an `AppError`; the panel renders
   `message`, `detail`, and the `fix` as a copyable command (one button). Rust
   only needs to keep returning the strings it already returns — do not rewrite
   the Rust error texts in this ticket, classify them.
5. `scripts/check.sh`, commit, rewrite this file, append `docs/PROGRESS.md`,
   `scripts/agent-lock.sh stop`.

## Notes from session 1 (VF-003)

* `src/settings.ts` exists and `main.ts` calls `settings.load()` at the top of
  `boot()`; `settings.value("output")` is the one legal way to read it. Do not
  edit `src/config.ts` numbers — they are now `DEFAULT_SETTINGS.output`; a new
  output field goes in `Settings`, `DEFAULT_SETTINGS`, `mergeSettings` and the
  README, in that order.
* The settings file is `<app config dir>/settings.json`, written by
  `read_settings`/`write_settings` in `src-tauri/src/lib.rs`. Rust stores text
  only: a new field never needs a Rust change.
* `settings.set()` is debounced (250 ms). Anything that must survive a quit calls
  `save()`/`flush()`; `beforeunload` already does.
* Nothing reads `deviceId`, `cameraId`, `accent`, `startMode` or `window.*` yet.
  `deviceId` is the natural carrier for the "which loopback device" error in
  VF-004/the device picker in VF-012 — do not invent a second place for it.
* `cargo test --lib` now has tests in `lib.rs` itself (`mod tests`); keep the
  temp-dir `Scratch` helper if you add file tests.

## Decisions open

* Store location: **settled** — the app config dir, one JSON file, Rust writes
  it (survives cache clears, inspectable, no plugin).
* `version` is rewritten to the current value on every save and unknown keys are
  dropped. A future field that needs preserving would need a passthrough map;
  nothing needs it yet.

## Found while working

* `src/mode.ts` still reads `VIICELL_MODE` at boot and ignores
  `settings.startMode`; the store has the field, nothing consumes it. A 5-line
  boot change would make "start in track" real, but the panel that sets it is
  VF-012 — decide there, not before.
* `window.width/height/x/y` are stored and validated, nothing reads or writes
  them; there is no window-state plugin and the contract forbids adding one
  without a ticket. Either a small ticket or drop the fields.
* `main.ts` is ~1340 lines and now also constructs the store at module scope;
  VF-005 should move that into `shell.ts`/boot wiring.
* `scripts/check.sh` still SKIPs the Windows compile gate (target not installed):
  every `#[cfg(windows)]` line is unverified, including the new commands' future
  Windows paths.
