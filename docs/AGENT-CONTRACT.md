# viicell-face — agent working contract

You are **one short session in a rotating crew**. Nobody remembers the previous
session; the repo does. Read these, in order, before touching anything:

1. this file
2. `docs/NEXT.md` — the baton: what to do first and what traps to avoid
3. `docs/SHIP-PLAN.md` — the ticket you are allowed to take
4. the tail of `docs/PROGRESS.md` — what the last few sessions did

## The loop

```
scripts/agent-lock.sh start      # exit 1 => another session is running: reply "busy" and STOP
<read the four files above>
<take exactly ONE ticket>
<implement + test + docs>
<verify with scripts/check.sh>
<commit>
<append PROGRESS.md, rewrite NEXT.md>
scripts/agent-lock.sh stop       # always, even after a failure
```

One ticket per session. A ticket is done when its **acceptance** line is true
and `scripts/check.sh` passes — not when the code "looks right".

## Hard rules

* **Never leave the tree broken.** `scripts/check.sh` must pass before you
  commit. If your ticket cannot keep it green, `git checkout -- .` the work,
  mark the ticket BLOCKED in `docs/NEXT.md` with the reason, and stop. A green
  tree with no progress beats a broken tree with half a feature.
* **Stay inside the ticket.** Noticed other problems? Write them under
  "Found while working" in `docs/NEXT.md`. Do not fix them now.
* **Commit style:** `VF-0xx: imperative summary` (ticket id first). Body: why,
  and anything the next session must know. One commit per session is ideal.
* **No new dependency** unless the ticket names it. If you must add one,
  justify it in the commit body and keep it out of the hot frame path.
* **Vendored files are read-only:** `public/mediapipe/**`, `public/models/**`,
  the reference `*.svg` files, `src-tauri/icons/**` (regenerate with
  `bunx tauri icon`).
* **Hot path discipline:** the frame pump (`main.ts` pumpFrame/push_frame) may
  not allocate per frame, may not `console.log`, may not await anything but the
  push. Nothing in `rig.ts`/`mouth.ts` may run per-frame work that can be cached.
* **Platform code goes behind `#[cfg]`** in `src-tauri/src/platform/`. A runtime
  `cfg!(...)` is fine for behaviour, never for compiling against a library that
  does not exist on that OS.
* **Docs are part of the ticket.** Behaviour changes ⇒ `README.md` changes in
  the same commit. The README is the product's best asset — do not let it drift.
* **Never invent results.** If you cannot run a build or a test on this machine
  (Windows, Android), say so and gate it as a ticket; do not claim it works.

## What the product is

A synthetic, rigged cartoon face published as a **virtual camera**, so Zoom /
Meet / OBS / browsers pick it up as a webcam. The face is driven by three
inputs: manual keys, the microphone (spectrum mouth), and the real webcam
(MediaPipe FaceLandmarker → head, blink, gaze, mouth).

Three ships:

| Target | Virtual camera mechanism | Status |
| --- | --- | --- |
| Linux (X11/Wayland) | `v4l2loopback` + V4L2 mmap writer | works, rough |
| Windows 10 1903+ / 11 | Media Foundation virtual camera (`mfvirtualcamera.h`) + shared-memory ring | not started |
| Android | **none exists** — ships as a face display / stream overlay app | not started |

Android has no API to publish a synthetic camera to other apps. Do not chase
one (root, LSPosed, VirtualXposed are out of scope). On Android the product is
"the face on screen", which is still useful for screen-recorded streams and is
the honest scope.

## Architecture at a glance

```
src/main.ts        app shell, frame pump, mode switch, HUD (the file that needs thinning)
src/face/*         art, rig, mouth, tracker, landmarks, calibration, tracking, lowlight, debug
src/input.ts       one control stream from devices or the focused window
src-tauri/src/     virtual_camera (V4L2), face_camera (MJPG), microphone (cpal),
                   input (/dev/input), pointer (Hyprland socket), ticker
```

Frame path: PixiJS renders a 1920×1080 artboard → `app.extract` → 1280×720 RGBA
→ `invoke("push_frame", Uint8Array)` raw body → Rust RGBA→YUYV → `mmap` write
into the loopback device. Anything that adds a copy, a base64, or a JSON byte
array to this path is a bug.

## Verification

```sh
scripts/check.sh           # everything below
bun test                   # TS tests (face maths, rig, tracking)
bunx tsc --noEmit          # types
cd src-tauri && cargo test --lib && cargo check
```

`bun run tauri dev` needs a display. A headless session can still run
`cargo check`, `cargo test`, `bun test`, `tsc`, `bun run build`. If you cannot
see the UI, say so — never claim visual work you did not look at. Prefer logic
that unit tests can pin (maths, state machines, pure renderers over DOM/strings)
over inline styling that only a human eye can check.

## When you are blocked

Cron sessions cannot ask questions. So:

* missing tool/service on this machine → mark the ticket BLOCKED in
  `docs/NEXT.md` with the exact command a human must run, then stop (do not
  silently pick a different phase).
* a design question with two defensible answers → pick the one that removes
  code, write the reason in the commit body, note the alternative under
  "Decisions open" in `docs/NEXT.md`.

## Report format (final response)

Max 8 lines, no preamble:

```
VF-0xx <ticket title> — done|blocked
what changed: 1 line
verified: check.sh green | what you could not run
next: VF-0yy
```
