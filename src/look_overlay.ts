/**
 * The full-monitor look overlay.
 *
 * While it is up it draws two marks over everything else, both as DOM elements
 * so they can never reach the frames published to the virtual camera:
 *
 * - a crosshair at the monitor point the tracker believes the eyes look at,
 *   which is the quickest way to tell whether the gaze map is working;
 * - a ring at the monitor point a calibration step asks the person to look at,
 *   so the corner looks are aimed at a mark instead of a guessed bezel.
 *
 * Both sit in the monitor's 0..1 coordinates. `main.ts` puts the window in
 * fullscreen while the layer is up, so those coordinates are the monitor's own
 * rather than the window's.
 */

import type { ScreenPoint } from "./anchor";

/** A monitor point as CSS percentages, clamped to the layer. */
export function overlayPosition(point: ScreenPoint): { left: string; top: string } {
  const percent = (value: number) =>
    `${Math.min(100, Math.max(0, Number.isFinite(value) ? value * 100 : 0))}%`;
  return { left: percent(point.u), top: percent(point.v) };
}

/** Places one mark, or hides it when there is no point to show. */
function place(element: HTMLElement, point: ScreenPoint | null): void {
  if (!point) {
    element.hidden = true;
    return;
  }

  const { left, top } = overlayPosition(point);
  element.hidden = false;
  element.style.left = left;
  element.style.top = top;
}

export class LookOverlay {
  readonly #root: HTMLElement;
  readonly #crosshair: HTMLElement;
  readonly #target: HTMLElement;

  constructor(root: HTMLElement, crosshair: HTMLElement, target: HTMLElement) {
    this.#root = root;
    this.#crosshair = crosshair;
    this.#target = target;
    this.setVisible(false);
  }

  get visible(): boolean {
    return !this.#root.hidden;
  }

  setVisible(visible: boolean): void {
    this.#root.hidden = !visible;
    if (!visible) {
      this.#crosshair.hidden = true;
      this.#target.hidden = true;
    }
  }

  /** The point the tracked eyes look at, in monitor units. */
  setCrosshair(point: ScreenPoint | null): void {
    place(this.#crosshair, point);
  }

  /** The point the current pose is measured against, in monitor units. */
  setTarget(point: ScreenPoint | null): void {
    place(this.#target, point);
  }
}
