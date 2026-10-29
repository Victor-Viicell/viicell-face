# viicell-face — ship plan

Alpha → 1.0 for **Linux**, **Windows**, **Android**. One ticket per session.
Take the first ticket in the lowest-numbered phase that is not DONE and not
BLOCKED, unless `docs/NEXT.md` names a different one.

Legend: `[ ]` todo · `[x]` done · `[!]` blocked (reason in NEXT.md)

Ticket format: **goal** — *acceptance* (the thing that must be true) — files.

---

## Phase A — ground truth (make the repo trustworthy)

- [x] **VF-003 settings store** — a typed, persisted config (JSON in the app
  config dir via `app_config_dir`, defaults, forward-compatible merge, one
  `save()` debounce), covering output res/fps, device id, camera id, origin,
  accent, mode, window state. Pure logic unit-tested, no DOM.
  *Acceptance:* `src/settings.ts` has tests; a reload restores every field;
  unknown/old keys are ignored instead of resetting the file.
  — `src/settings.ts`, `src/settings.test.ts`, `src-tauri/src/lib.rs`

- [x] **VF-004 error taxonomy** — one `AppError { code, message, detail, fix? }`
  type; every `invoke` failure and every device problem maps into it; one panel
  renders `message` + `fix` (copyable command), never a raw Rust string.
  *Acceptance:* a missing loopback device, a busy webcam, a denied mic and a
  missing udev rule each render a distinct panel with one action button.
  — `src/errors.ts`, `src/errors.test.ts`, `index.html`, `main.ts`

- [ ] **VF-005 split `main.ts`** — 1322 lines is the reason the UI is rough.
  Extract, with no behaviour change: `shell.ts` (DOM refs + panels),
  `stream.ts` (connect/pump/push, fps accounting), `controls.ts` (keys/wheel),
  `hud.ts` (status text + chips). `main.ts` becomes boot + wiring only (<250
  lines). *Acceptance:* tests green, `main.ts` < 250 lines, frames still flow
  (`build` + manual note in PROGRESS).
  — `src/*.ts`, `src/main.ts`

## Phase B — interface rework (the reason for this project pass)

- [ ] **VF-010 layout shell** — stage + docked panel, canvas letterboxed with
  integer-ish scaling (no half-pixels), 16:9 kept in any window shape, panel
  collapsible with a remembered width. Kill the bleed/overlap layout where
  HUD, hints, guide and calibration all float over the canvas.
  *Acceptance:* at 640×360, 1280×720 and 1920×1080 nothing overlaps the face
  safe area and no control is clipped; layout maths unit-tested.
  — `index.html`, `src/styles.css`, `src/shell.ts`

- [ ] **VF-011 status bar** — one row of chips: mode, device + format, measured
  fps, dropped frames, mic, face camera, keys(global/window), origin. Colour =
  state (ok/warn/off), tooltip = the fix. *Acceptance:* each chip has a
  documented source and updates from the existing status polls; no text jumps.
  — `src/hud.ts`, `styles.css`

- [ ] **VF-012 settings panel** — bind VF-003: resolution, fps, device picker
  (with "recommended" marker), camera picker, origin grid, accent, "start in
  track". Changing resolution restarts the stream with a visible busy state.
  *Acceptance:* every control round-trips through the store and survives a
  restart; invalid sizes are clamped before they reach Rust.
  — `src/shell.ts`, `settings.ts`

- [ ] **VF-013 first-run wizard** — 4 steps: virtual camera present? → input
  permission → microphone → webcam. Each step: current state, what it is for,
  one button (copy command / retry / skip). Remembered; can be reopened from
  the panel. *Acceptance:* a fresh config with no loopback device lands in the
  wizard, not in a dead canvas; skipping is respected on next boot.
  — `src/onboarding.ts`, `index.html`

- [ ] **VF-014 shortcut overlay** — replace the always-visible `aside#guide`
  with an overlay on `F1`/`?` (Esc closes), grouped by task, showing only the
  keys valid in the current mode. *Acceptance:* one hero hint stays visible
  ("hold a side button"); the full map is no longer taking 25% of the window.
  — `index.html`, `src/controls.ts`

- [ ] **VF-015 calibration flow** — single centered dialog: step list with
  checkmarks, big instruction, live preview, progress ring, keyboard
  (Space = next when ready, Esc = cancel). No fullscreen round-trip for the
  mouth/eyes runs; pupils keep the fullscreen corner marks but say so first.
  *Acceptance:* the three presets can be run end-to-end with the keyboard only;
  cancelling restores the exact prior UI state.
  — `src/main.ts` (calibration), `styles.css`

- [ ] **VF-016 tray + window state** — tray menu: Open · mode toggle · pause
  streaming · quit; window position/size/fullscreen persisted; "close = hide
  to tray" surfaced as a setting (Linux desktop may have no tray host at all →
  fall back to quitting on close, with a one-time notice).
  *Acceptance:* no lost window state across restarts; no tray → app still
  quits and says why in the log.
  — `src-tauri/src/lib.rs`, `settings`

- [ ] **VF-017 narrow/mobile layout** — < 760 px: panel becomes a bottom sheet
  with 3 tabs (Face · Stream · Track); touch targets ≥ 44 px; safe-area insets
  for Android notches. *Acceptance:* the sheet's tab maths unit-tested; no
  horizontal scroll at 360×640.
  — `styles.css`, `src/shell.ts`

- [ ] **VF-018 identity** — proper app icon (favicon-style face mark, not the
  Tauri default), window title, About block (version, commit, licenses of
  PixiJS/MediaPipe), splash-free boot (no white flash: `background-color` on
  `html`).
  *Acceptance:* icons regenerated for all platforms; About shows a real version.
  — `src-tauri/icons/**`, `index.html`

- [ ] **VF-019 a11y + motion** — focus rings, `aria-live` on the status line,
  `prefers-reduced-motion` (drops easing + aurora drift, keeps the face
  legible), minimum contrast of chips. *Acceptance:* tab order reaches every
  control; reduced-motion reduces the animation clock, not the frame rate.
  — `styles.css`, `src/rig.ts`, `backdrop.ts`

## Phase C — Linux hardening (kill the "it broke once" class of bugs)

- [ ] **VF-020 device negotiation** — enumerate loopback devices properly
  (name, max_width/height, formats), pick the best, clamp requested size to the
  device, fall back to 640×480, and report *which* device and *why*. Also
  handle "device exists but is opened by another writer".
  *Acceptance:* choosing 1920×1080 on a 1280×720 device clamps instead of
  failing; two devices → the named one wins.
  — `virtual_camera.rs`

- [ ] **VF-021 hotplug + reconnect** — device disappears/reappears (module
  reload, unplug) → writer stops, HUD says "device gone", a 2 s poll
  reconnects. *Acceptance:* `sudo modprobe -r v4l2loopback && modprobe` during
  streaming recovers without a restart.
  — `virtual_camera.rs`, `lib.rs`

- [ ] **VF-022 DPI/readback correctness** — canvas backing store must be the
  output size regardless of `devicePixelRatio`; CSS size may differ. Also
  handle monitor scale changes mid-session. *Acceptance:* at 1.5× scale the
  extracted frame is exactly width×height and the face is not cropped.
  — `main.ts`, `paint.ts`

- [ ] **VF-023 colour pipeline** — decide and document sRGB→YUYV (BT.601 full
  vs limited range), match what browsers expect, keep the dither. Verify with a
  grey-ramp render: no crush, no banding, no green cast.
  *Acceptance:* a 32-step grey ramp reads back as 32 distinct luma steps in
  `ffplay`/`ffmpeg -f rawvideo` sample.
  — `virtual_camera.rs`, `backdrop.ts`

- [ ] **VF-024 frame pacing** — one clock for render/push/writer; drop
  accounting that tells the truth (pushed, written, dropped); never push faster
  than the device writes. *Acceptance:* HUD fps equals `v4l2-ctl --get-parm`
  reality within 2 %; a stalled consumer drops frames instead of growing memory.
  — `virtual_camera.rs`, `ticker.rs`, `stream.ts`

- [ ] **VF-025 leak audit** — 10-minute run: RSS and GPU memory flat; Pixi
  textures/filters destroyed on resize and mode switch; every `listen()` has an
  unsubscribe on teardown. *Acceptance:* numbers recorded in PROGRESS (before/
  after), no unbounded growth.
  — `rig.ts`, `main.ts`

- [ ] **VF-026 input robustness** — keyboard layout independence (use codes,
  not chars, where possible), autorepeat, stuck modifier on focus loss,
  multiple keyboards, hotplug of the device, and a graceful "permission denied"
  path. *Acceptance:* holding a side button and switching TTY/focus cannot
  leave a channel stuck; a second keyboard works.
  — `input.rs`, `input.ts`

- [ ] **VF-027 pointer + multi-monitor** — normalise per monitor with negative
  origins and mixed scales; X11 fallback (`XQueryPointer`); never let a monitor
  change produce NaN look values. *Acceptance:* two monitors with different
  scale produce identical look values for the same physical point; unit test on
  the normalisation.
  — `pointer.rs`, `gaze.ts`

- [ ] **VF-028 mic robustness** — default device change, 44.1/48 kHz, mono vs
  stereo, device removal, and a "no input" state that does not spam errors.
  *Acceptance:* unplugging the mic mid-run leaves the mouth at rest and the HUD
  at `mic off`; replugging recovers on the next tick.
  — `microphone.rs`

- [ ] **VF-029 crash safety + logging** — no `unwrap`/`expect` on device paths,
  `log` to `~/.local/share/viicell-face/logs/app.log` with rotation, panic hook
  that writes the backtrace and (optionally) shows a panel. *Acceptance:* every
  device failure path returns an error instead of panicking (grep-audited).
  — `src-tauri/src/*`

- [ ] **VF-030 security** — real CSP (`default-src 'self'`; MediaPipe needs
  `wasm-unsafe-eval`), `withGlobalTauri: false` + explicit imports, capability
  list trimmed to the commands actually used, no `shell` plugin. *Acceptance:*
  app boots under CSP with tracking on; no console violations.
  — `tauri.conf.json`, `capabilities/default.json`

## Phase D — Windows

- [ ] **VF-040 platform split** — `src-tauri/src/platform/{linux,windows}/`;
  the Linux modules move behind `#[cfg(target_os = "linux")]`; Windows stubs
  return a typed "unsupported" error. `rustup target add
  x86_64-pc-windows-msvc` and `cargo check --target` green (check.sh already
  gates it once installed). *Acceptance:* windows target compiles with no
  warnings about missing items; Linux build unchanged.
  — tree-wide

- [ ] **VF-041 shared-memory transport** — the RGBA frames move from IPC into a
  named shared-memory ring (one writer, one reader, seqlock header) so the
  virtual camera sink no longer depends on Tauri IPC; Linux keeps V4L2 but reads
  from the same ring. *Acceptance:* the Linux path still hits its fps with the
  ring; ring has a unit test for wraparound and torn reads.
  — `src-tauri/src/transport.rs`

- [ ] **VF-042 Windows virtual camera** — Media Foundation virtual camera
  (`mfvirtualcamera.h`, Win10 1903+) reading the ring; install/uninstall
  (registration is per-user, no admin); fallback message when the OS is too old.
  *Acceptance:* `cargo check` green on windows; a manual test plan exists and is
  marked UNVERIFIED until run on real hardware (never claim it works).
  — `platform/windows/vcam.rs`

- [ ] **VF-043 Windows camera capture** — Media Foundation source reader,
  MJPG/RGB32, 640×480@30, same `face_frame` contract. *Acceptance:* compiles;
  test plan documented.
- [ ] **VF-044 Windows global input** — `WH_KEYBOARD_LL` + `WH_MOUSE_LL` in a
  thread with its own message loop, passive (never swallow), side-button gate
  identical to Linux. *Acceptance:* compiles + parity table in README.
- [ ] **VF-045 Windows cursor + DPI** — `GetCursorPos`, per-monitor DPI aware
  manifest, monitor work-area normalisation shared with VF-027.
- [ ] **VF-046 Windows shell parity** — tray, close-to-tray, autostart via
  registry `Run` key, single-instance guard.
- [ ] **VF-047 Windows installer** — NSIS per-user install, VC++ runtime
  bundled-or-detected, SmartScreen/unsigned note in README, uninstall removes
  the camera registration.

## Phase E — Android (face display, not a virtual camera)

- [ ] **VF-050 toolchain** — JDK 17 (Temurin tarball in `~/.local`), Android
  cmdline-tools + platform 34 + build-tools, NDK r26, `rustup target add
  aarch64-linux-android armv7-linux-androideabi`, env file sourced by
  `scripts/android-env.sh`. *Acceptance:* `sdkmanager --list` works and
  `cargo check --target aarch64-linux-android` reaches our crate.
- [ ] **VF-051 mobile init** — `bunx tauri android init`, `#[cfg(mobile)]`
  command set (no v4l2/input/pointer/tray), `mobile_entry_point` wired, app
  boots to the face full-screen. *Acceptance:* `aarch64` compiles; APK builds.
- [ ] **VF-052 mobile UI** — bottom sheet (VF-017) as the primary surface,
  gestures instead of keys (drag = look, two-finger = lids, tap = blink), safe
  areas, portrait and landscape, wake-lock while the face is live.
- [ ] **VF-053 mobile camera** — front camera for tracking, permission flow,
  background/foreground release, and degrade to manual+mic when denied.
- [ ] **VF-054 face studio mode** — screen-record friendly: hide all chrome, keep
  the face + mic, optional chroma-key background, orientation lock. Document
  that other apps cannot pick this up as a camera, with the reason.
- [ ] **VF-055 release build** — signed AAB + universal APK, versionCode from
  package.json, minSdk 26, targetSdk 34, store listing text + 2 screenshots.

## Phase F — release

- [ ] **VF-060 versioning** — single source of truth (`package.json`) → Cargo +
  tauri.conf via a script; `CHANGELOG.md` (Keep a Changelog); `LICENSE` chosen
  with the owner (MIT vs AGPL — MediaPipe model license must be checked and
  attributed); `NOTICE` for vendored wasm/model.
- [ ] **VF-061 Linux packages** — AppImage + deb (and an AUR PKGBUILD if cheap);
  the two `sudo` scripts become a single `pkexec`-based in-app action
  ("Enable global keys", "Create camera device") so nobody has to read a README
  to get a working camera.
- [ ] **VF-062 README per platform** — install, first run, permissions, the
  three modes, troubleshooting matrix, and an honest support table.
- [ ] **VF-063 QA matrix** — the failure bank (below) turned into a checklist
  with pass/fail per platform; results committed.
- [ ] **VF-064 1.0.0** — tag, build all artifacts, record hashes, write the
  release notes.

---

## Appendix — failure bank (the preventive checks)

Every one of these has bitten a project of this shape. VF-063 turns them into a
checklist; tickets above close them one by one.

**Virtual camera / V4L2**
1. loopback module absent; 2. module loaded with one device only; 3. requested
size above `max_width/height`; 4. device already written by another process;
5. consumer opens the device *before* the writer (black frames); 6. consumer
disconnects mid-stream (EPIPE/ENODEV must not panic); 7. device removed under
us; 8. format negotiation drift (consumer picks MJPG); 9. no even width/height
(YUYV pairs); 10. writer faster than the device, queue overrun.

**Video pipeline**
11. colour range/primaries mismatch (green cast); 12. banding on the vignette;
13. canvas backing store vs CSS size (DPI) cropping the face; 14. extract with
the skeleton overlay visible; 15. tearing from a partially written frame;
16. memory growth from Pixi textures/filters on resize; 17. GC pause from a
per-frame allocation; 18. blur/dither shader recompiled per frame; 19. frame
pushed while the window is hidden (rAF stall) — solved by the ticker, keep it.

**Camera / tracking**
20. exclusive camera (OBS holds it); 21. permission denied (macOS/Android
analog); 22. camera unplugged mid-track; 23. resolution mismatch to the model;
24. dark room (lowlight lift already there — keep it bounded); 25. tracking
jitter vs. latency tradeoff (One Euro params); 26. calibration captured
mid-blink; 27. stale calibration after a camera change; 28. face lost for N
frames keeps the crop (already) — must not freeze the face forever.

**Audio**
29. no default device; 30. sample-rate/format mismatch; 31. device removed;
32. Bluetooth headset switch (device id changes); 33. mic permission denied;
34. DC offset / AGC pumping in the spectrum.

**Input**
35. udev rule missing → keys only in focus; 36. layout-dependence of `z/x/c`;
37. stuck modifier across focus change; 38. second keyboard; 39. Wayland vs
X11 pointer; 40. negative monitor origin; 41. mixed DPI monitors; 42. cursor on
another workspace; 43. keyboard autorepeat flooding the pose.

**Platform / packaging**
44. no tray host on GNOME → window unrecoverable; 45. "close" quits when the
user means "hide"; 46. app installed from a bundle cannot find `public/`;
47. model/wasm loaded from a `file://` or CSP-blocked origin; 48. Windows
per-monitor DPI blur; 49. Android back button / process death while streaming;
50. battery & thermal throttling on a 60 fps render loop in a WebView.

**Product / correctness**
51. settings not persisted → the app feels like a demo; 52. an error surfaced
as a raw Rust string; 53. two sources of truth for the output config
(`config.ts` vs Tauri); 54. version drift between package.json, Cargo.toml and
tauri.conf.json; 55. README describing behaviour that no longer exists;
56. no way to check "is the camera really working" without another app;
57. unrecoverable state after a failed calibration; 58. hot path silently
degraded by a well-meaning refactor (measure before/after).
