/**
 * The point the eyes look *from*, shared by the cursor and camera modes.
 *
 * Both modes aim the pupils at a point on the monitor, and both let you pick
 * where the face stands relative to that screen: the centre by default, or one
 * of the four corners. Re-centring is the same operation either way, so it lives
 * here, free of the pointer backend and the renderer, and is tested on its own.
 */

/** Screen points the number keys pick as the origin, in key order. */
export const GAZE_ANCHORS = ["topLeft", "topRight", "center", "bottomLeft", "bottomRight"] as const;

export type GazeAnchor = (typeof GAZE_ANCHORS)[number];

/** A point on the monitor, 0..1 across it. */
export interface ScreenPoint {
  /** 0 = left edge of the screen, 1 = right edge. */
  u: number;
  /** 0 = top edge of the screen, 1 = bottom edge. */
  v: number;
}

export const ANCHOR_POINTS: Record<GazeAnchor, ScreenPoint> = {
  topLeft: { u: 0, v: 0 },
  topRight: { u: 1, v: 0 },
  center: { u: 0.5, v: 0.5 },
  bottomLeft: { u: 0, v: 1 },
  bottomRight: { u: 1, v: 1 },
};

export const ANCHOR_LABELS: Record<GazeAnchor, string> = {
  topLeft: "top left",
  topRight: "top right",
  center: "centre",
  bottomLeft: "bottom left",
  bottomRight: "bottom right",
};

/** The middle of the screen: the identity origin. */
export const SCREEN_CENTRE: ScreenPoint = { u: 0.5, v: 0.5 };

/**
 * Re-centres a point on the origin the eyes look from.
 *
 * A point sitting on the origin reads as 0.5 (straight ahead) and the farthest
 * edge of the screen reads as 0 or 1, the rig's full deflection. So a corner
 * origin sweeps more gently than the centre one, and a point in the middle of
 * the screen seen from a corner is below and to the side, as if the face stood
 * in that corner. With the centre origin nothing moves.
 */
export function fromOrigin(point: ScreenPoint, origin: ScreenPoint): ScreenPoint {
  const reachU = Math.max(origin.u, 1 - origin.u);
  const reachV = Math.max(origin.v, 1 - origin.v);

  return {
    u: 0.5 + (point.u - origin.u) / (2 * reachU),
    v: 0.5 + (point.v - origin.v) / (2 * reachV),
  };
}
