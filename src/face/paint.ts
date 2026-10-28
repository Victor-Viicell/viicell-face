/**
 * Fill descriptions shared by the face and the mouth.
 *
 * A paint is either a plain colour or a gradient described in shape-local
 * coordinates: `0..1` spans the bounds of whatever shape is being filled. That
 * is what lets one description paint both mirrored eyes without knowing where
 * they sit on the artboard.
 *
 * `FillGradient` builds a small texture, so instances are cached by paint
 * identity. The paints are module-level constants, which means the two shells
 * share one texture, the two irises another, and so on.
 */

import { FillGradient } from "pixi.js";

export interface PaintStop {
  /** Position along the gradient, 0..1. */
  offset: number;
  color: string;
}

export interface PaintPoint {
  x: number;
  y: number;
}

export type Paint =
  | string
  | {
      type: "linear";
      from: PaintPoint;
      to: PaintPoint;
      stops: readonly PaintStop[];
    }
  | {
      type: "radial";
      center: PaintPoint;
      radius: number;
      stops: readonly PaintStop[];
    };

const gradients = new WeakMap<Exclude<Paint, string>, FillGradient>();

/** Builds (or reuses) the Pixi fill for a paint. */
export function paintToFill(paint: Paint): FillGradient | string {
  if (typeof paint === "string") {
    return paint;
  }

  const cached = gradients.get(paint);
  if (cached) {
    return cached;
  }

  const gradient = new FillGradient({
    type: paint.type,
    colorStops: [...paint.stops],
    textureSpace: "local",
    ...(paint.type === "linear"
      ? { start: paint.from, end: paint.to }
      : {
          center: paint.center,
          innerRadius: 0,
          outerRadius: paint.radius,
        }),
  });

  gradients.set(paint, gradient);
  return gradient;
}

/** A gradient from `from` to `to`, in shape-local 0..1 coordinates. */
export function linear(
  from: PaintPoint,
  to: PaintPoint,
  stops: readonly PaintStop[],
): Paint {
  return { type: "linear", from, to, stops };
}

/** A circular gradient centred in the shape. `radius` is in its own bounds. */
export function radial(radius: number, stops: readonly PaintStop[]): Paint {
  return { type: "radial", center: { x: 0.5, y: 0.5 }, radius, stops };
}
