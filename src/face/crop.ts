/**
 * Framing for the camera preview.
 *
 * The preview zooms onto the face instead of showing the whole capture: the
 * landmarks give a box, which is padded, matched to the preview's aspect and kept
 * inside the frame. The maths is pure so the aspect handling can be tested
 * without a camera.
 */

/** A region of the camera frame, in 0..1 coordinates. */
export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The whole frame. */
export const FULL_CROP: Crop = { x: 0, y: 0, w: 1, h: 1 };

/** Margin kept around the face, as a share of its size. */
const FACE_MARGIN = 0.06;
/** Tightest crop, so a distant face is not blown up into mush. */
const MIN_CROP = 0.4;
/** Seconds the crop takes to follow the face; stops the picture from jittering. */
export const CROP_TAU = 0.22;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

/** The box around every point, or null when there is nothing to frame. */
export function boxOf(points: readonly { x: number; y: number }[]): Crop | null {
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;

  for (const { x, y } of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  if (maxX <= minX || maxY <= minY) {
    return null;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Pads the box and matches it to the preview's aspect.
 *
 * `aspect` is the preview's shape in these unit coordinates, not in pixels:
 * `(previewWidth / previewHeight) * (frameHeight / frameWidth)`. A 4:3 preview
 * of a 4:3 capture is therefore square here, which is what lets a portrait face
 * fill the height of a wide preview.
 */
export function frameAround(box: Crop, aspect: number): Crop {
  const centreX = box.x + box.w / 2;
  const centreY = box.y + box.h / 2;
  let w = box.w * (1 + 2 * FACE_MARGIN);
  let h = box.h * (1 + 2 * FACE_MARGIN);

  // A face is taller than it is wide, so widen the crop until it matches the
  // preview rather than squashing the picture.
  if (w < h * aspect) {
    w = h * aspect;
  } else {
    h = w / aspect;
  }

  if (w < MIN_CROP) {
    w = MIN_CROP;
    h = w / aspect;
  }

  // Never run past the frame, and keep the aspect while fitting inside it.
  const fit = Math.min(1 / w, 1 / h);
  if (fit < 1) {
    w *= fit;
    h *= fit;
  }

  return {
    x: clamp(centreX - w / 2, 0, 1 - w),
    y: clamp(centreY - h / 2, 0, 1 - h),
    w,
    h,
  };
}

/**
 * Moves the crop towards the target. Every crop has the preview's aspect, and
 * the mix is linear, so the aspect is kept all the way through the motion.
 */
export function easeCrop(current: Crop, target: Crop, dt: number): Crop {
  if (dt <= 0) {
    return target;
  }

  const alpha = 1 - Math.exp(-dt / CROP_TAU);
  const mix = (from: number, to: number) => from + (to - from) * alpha;
  return {
    x: mix(current.x, target.x),
    y: mix(current.y, target.y),
    w: mix(current.w, target.w),
    h: mix(current.h, target.h),
  };
}
