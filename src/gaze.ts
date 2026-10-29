import { listen } from "@tauri-apps/api/event";
import {
  ANCHOR_LABELS,
  ANCHOR_POINTS,
  SCREEN_CENTRE,
  fromOrigin,
  type GazeAnchor,
  type ScreenPoint,
} from "./anchor";

/**
 * Where the eyes look, and from where.
 *
 * The pupils follow the desktop pointer. The origin says which point of the
 * screen they look *from*: the centre by default, or one of the four corners.
 * A cursor to the right of a centre origin is straight to the side; the same
 * cursor seen from the top-left origin is below and to the right, as if the
 * face stood in that corner of the screen.
 *
 * The origin itself is shared with the camera mode; see `./anchor`.
 */

export { GAZE_ANCHORS } from "./anchor";
export type { GazeAnchor } from "./anchor";

export type GazePoint = ScreenPoint;

const STALE_MS = 1500;
/** Seconds to cover roughly two thirds of the way to a new target. */
const FOLLOW_TAU = 0.09;

const isTauri = "__TAURI_INTERNALS__" in window;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

export class Gaze {
  /** The point the eyes look from; the middle of the screen until picked. */
  #origin: GazeAnchor = "center";
  /** Smoothed aim: what the rig is drawn with. */
  #aim: GazePoint = { ...SCREEN_CENTRE };
  /** Latest cursor position from the desktop backend. */
  #desktop: GazePoint | null = null;
  /** `performance.now()` when `#desktop` last arrived. */
  #desktopAt = 0;
  /** Latest pointer position inside the window. */
  #local: GazePoint | null = null;

  get origin(): GazeAnchor {
    return this.#origin;
  }

  /** Human name of the origin, for the status line. */
  get label(): string {
    return ANCHOR_LABELS[this.#origin];
  }

  /** The origin as a screen point, for anything that aims its own way. */
  get anchor(): GazePoint {
    return ANCHOR_POINTS[this.#origin];
  }

  /** Where a cursor-driven gaze gets its point from, for the status line. */
  get source(): "monitor" | "window" | "none" {
    if (this.#liveDesktop()) {
      return "monitor";
    }
    return this.#local ? "window" : "none";
  }

  setOrigin(origin: GazeAnchor): void {
    if (origin === this.#origin) {
      return;
    }

    this.#origin = origin;
    console.info(`viicell-face: eyes look from the ${ANCHOR_LABELS[origin]}`);
  }

  /** Pointer moved over the canvas; the only source in a plain browser. */
  pointerOver(point: GazePoint): void {
    this.#local = { u: clamp01(point.u), v: clamp01(point.v) };
  }

  start(): void {
    if (!isTauri) {
      return;
    }

    // Pushed from the backend: polling with a timer would slow to about once a
    // second whenever the window is hidden.
    void listen<GazePoint>("pointer", ({ payload }) => {
      this.#desktop = { u: clamp01(payload.u), v: clamp01(payload.v) };
      this.#desktopAt = performance.now();
    });
  }

  /** Advances the easing and returns where the eyes should look now. */
  update(dt: number): GazePoint {
    const target = this.#target();
    // Frame-rate independent easing, so the pupils glide instead of snapping.
    const alpha = 1 - Math.exp(-Math.max(dt, 0) / FOLLOW_TAU);
    this.#aim = {
      u: this.#aim.u + (target.u - this.#aim.u) * alpha,
      v: this.#aim.v + (target.v - this.#aim.v) * alpha,
    };
    return this.#aim;
  }

  #target(): GazePoint {
    const cursor = this.#liveDesktop() ?? this.#local ?? SCREEN_CENTRE;
    return this.#fromOrigin(cursor);
  }

  /** Re-centres the cursor on the origin; the maths is shared with the camera. */
  #fromOrigin(cursor: GazePoint): GazePoint {
    return fromOrigin(cursor, this.anchor);
  }

  /** The desktop cursor, unless the samples have stopped arriving. */
  #liveDesktop(): GazePoint | null {
    const age = performance.now() - this.#desktopAt;
    return this.#desktop && age < STALE_MS ? this.#desktop : null;
  }
}
