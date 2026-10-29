# NEXT — the baton

**Take: VF-012 — settings panel.**

Why next: VF-011 is done and the status row now reports measured facts, so the
dock's foot is final. VF-012 binds the settings store (VF-003) to real controls,
which is the first ticket where changing something in the UI has to survive a
restart and restart the stream — everything after it (wizard, overlay,
calibration flow) assumes those controls exist.

## How

1. `scripts/agent-lock.sh start`
2. Read `docs/AGENT-CONTRACT.md`, this file, `docs/SHIP-PLAN.md` (Phase B,
   VF-012), and the tail of `docs/PROGRESS.md` (session 5 = the status row you
   are sitting under).
3. `src/main.ts` is at 243 of its 250 lines (`src/main.test.ts` enforces it).
   **Split something out before adding wiring** — `src/stream.ts` already owns
   `connect()`/`refreshStatus()`, so the panel's handlers belong in a new
   `src/settings_panel.ts` (`installSettingsPanel(settings, {reconnect, relayout})`
   and a `settings.value()` → control paint), with ids queried through `shell.ts`
   like everything else. Do not raise the 250.
4. Controls, in the order they are worth doing:
   * **output size + fps** — the acceptance core. Write the store first
     (`settings.set({ output: { width, height } })`, the store deep-merges and
     clamps to `LIMITS.output`, even-pixel sizes included), then restart with
     `connect()`: `start_camera` already tears the old writer down when the size
     or rate differs (`src-tauri/src/lib.rs`), and `connect()` sets `streaming =
     false`, paints `starting…` and re-reads `settings.value("output")`. The
     "visible busy state" is that HUD line plus a `disabled` class on the
     controls until the promise settles. A failure lands in the existing panel
     through `shell.showError`.
   * **origin grid** — cheapest: `settings.gazeOrigin` + the same path the `0`
     and `1`–`5` keys use (`gaze.setOrigin` via `controls.ts`); the status row's
     `origin` chip must agree with the grid, so paint it from the store, not from
     a second variable.
   * **start in track** — `src/mode.ts`'s `startupFaceMode()` asks Rust for
     `VIICELL_MODE` today and `main.ts` prefers that; the setting should win over
     the env var (env stays as the power-user override) — decide which way round
     and write it in the commit body.
   * **accent** — `settings.accent` is a `#rrggbb` and *nothing reads it yet*;
     it needs a pupil-colour entry point in `src/face/rig.ts`. If that is more
     than a setter, land the rest of the ticket first and leave accent for a
     follow-up rather than half-wiring it.
   * **device + camera pickers — they do not fit yet.** `start_camera()` takes
     no device argument (Rust picks with `VIICELL_VIDEO_DEVICE`), and there is no
     command that lists webcams (`virtual_camera::list_devices()` is loopbacks
     only; `face_camera::find_device()`/`probe_capture()` exist but nothing
     exposes them). Either add the argument plus a `list_cameras` command in this
     ticket (small, no new dependency, mirrors `list_devices`) or ship the two
     pickers as "recommended" lists and say plainly in NEXT that the backend
     wiring is owed. Do not ship a picker that writes a setting nothing reads —
     that is the trap this ticket is most likely to fall into.
5. Every control round-trips: `settings.test.ts` already pins merge/clamp, so a
   new field needs `Settings`, `DEFAULT_SETTINGS`, `mergeSettings`, the full
   literal in `settings.test.ts` (tsc catches it) and the README table.
6. `scripts/check.sh`, commit, rewrite this file, append `docs/PROGRESS.md`,
   `scripts/agent-lock.sh stop`.

## Notes from session 5 (VF-011)

* **The status row is `statusChips()` → `setHudChips()`.** `src/hud.ts` is pure
  and returns `{key, label, state, tooltip}` (key: a union, so `shell.ts` keys
  its nodes by it); `shell.setHudChips` reuses one node per key and writes only
  what changed. If a new setting needs a chip, add it to the union **and** keep
  the order stable — the row's whole point is that nothing reflows under the
  reader.
* **`shell.setHud(state, text)` is the one-line path** and it hides the row: a
  cold start, a stopped camera, the browser preview, and the failure headline.
  So a panel that sets a message takes the strip over until the next poll
  (≤ 1 s) repaints the chips. Do not paint a message *and* expect chips beside
  it.
* The fixes in the tooltips come from `src/errors.ts` (`inputDenied().fix`, the
  newly exported `MIC_FIX`); keep it that way rather than adding a second copy
  of a command in the panel.
* `hud.dataset.state` is the worst chip's (`warn` was added to `HudState`), which
  is what keeps the folded dock's dot honest. The folded CSS hides
  `#hud-text` **and** `#hud-chips`.
* Measured in Chromium: the 295 px foot holds the eight chips in three rows
  (78 px); at a 640×360 window the column caps at 234 px and the strip is five
  rows (124 px). If a setting panel needs foot space, that is where it goes.
* `.chip` takes the pointer back from `.hud` (`pointer-events: auto`) because a
  `title` needs the pointer; keep that if you add a chip kind.

## Standing traps (older sessions, still true)

* **The layout is arithmetic + a paint, never CSS guesses.** `src/layout.ts`
  returns `{panel, stage, view, safe, content, unit}`; `shell.installLayout(() =>
  settings.value("panel"))` writes `--panel-width`, `--view-x/y/w/h` and the
  `folded` class, and repaints on `resize`. Ask `layoutFor`, never
  `getBoundingClientRect` at boot.
* **`Settings.panel` is the only place the fold lives** (`{width, collapsed}`,
  remembered in `settings.json`). `set()` deep-merges `panel`, so `{collapsed}`
  keeps a remembered width. No `localStorage`, no module copy. A width control
  is VF-012's if it has room: write the value, then `shell.relayout()`.
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
* **Element ids are a runtime null `tsc` cannot see.** Session 5 re-checked the
  38 ids `shell.ts` queries against `index.html` with `comm` (0 missing); do the
  same after renaming one. `src/main.ts` also may hold no `querySelector`.
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
  + CDP for CSS, or `bunx vite --port 5173` and
  `await import('/src/shell.ts')` in the page to exercise the real modules.
  Kill both servers before you commit.

## Decisions open

* `gstreamer_missing` exists in the taxonomy with no producer. Either the
  webview-capture fallback appears (Phase C) or the code should be dropped; do
  not wire it to a guess.
* The mic fix offers `systemctl --user restart wireplumber`, never run on this
  box. If a real denied mic is ever seen, correct the command and the README.
* `body.looking` hides the dock but the stage keeps `right: var(--panel-width)`,
  so fullscreen is not re-centred for the pupil run. VF-015 decides.
* At a 360 px-tall window the dock body scrolls (14 key rows); VF-014 removes
  them. Until then the status strip (three to five rows) is the tallest fixed
  part of the foot.
* `docs/SHIP-PLAN.md` Phase A still describes `main.ts` as the calibration
  entry point; the flow lives in `src/track_view.ts`.

## Found while working

* `#debug-row`, `#look-row` and `#lean-row` are lit through `shell.setRowActive`;
  the guide scrolls now, so a lit row can be out of sight. VF-014's overlay
  should keep the lit state.
* The browser preview calls `wireButtons()` before `installStream`; the retry
  button would reject if it were reachable there. Either guard `connect()` on
  "stream installed" or skip that button in preview.
* `scripts/check.sh` still SKIPs the Windows compile gate (target not
  installed): every `#[cfg(windows)]` line is unverified.
* `connect()`'s success line is a message, not chips, because `startCamera`
  echoes what was *asked for* rather than what the writer measured. If VF-012's
  restart makes that line flicker, the fix is to paint chips optimistically from
  `info` with `fps` marked as "target", not to slow the poll.
* `run_capture`/`find_device` in `face_camera.rs` already probe
  `/dev/video*`; a `list_cameras` command is mostly plumbing, which is why the
  camera picker is worth doing properly in VF-012 rather than faking the list.
