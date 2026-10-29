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
