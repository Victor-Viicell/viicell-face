/**
 * Lifts a dim camera frame before the landmark model reads it.
 *
 * A single lamp, a monitor's glow, or a dark room leaves a face much darker than
 * the model's training data, and every landmark gets shakier with it. A global
 * brightness change cannot fix a face lit from one side, so this divides by the
 * *local* brightness instead: each part of the picture is brought towards a
 * common exposure, which lifts the shadow side of a face next to a small light
 * without blowing out the lit side. Only shadows are lifted — a pixel whose
 * neighbourhood is already bright is left untouched — and the gain is capped, so
 * sensor noise in near-black areas is not amplified without limit.
 *
 * The analysis runs on a thumbnail, so the cost is independent of the frame
 * size; the full-frame pass only happens when there is something to lift.
 */

/** Type of a picture the model and the preview can both draw. */
export type FrameSource = ImageBitmap | HTMLCanvasElement;

/** Cells the local brightness is measured on. */
const GRID_W = 80;
const GRID_H = 60;
/** Local brightness the lift aims for, 0..255. */
const TARGET = 132;
/** Brightness treated as black when dividing, which bounds the gain. */
const FLOOR = 24;
/** Most the shadows may be lifted; above this the noise is worse than the dark. */
const MAX_GAIN = 3;
/** A frame that needs less than this is passed through untouched. */
const MIN_LIFT = 1.06;
/** Box-blur passes over the brightness map, so a lamp's edge does not cut. */
const BLUR_PASSES = 2;

/** Rec. 601 luminance, integer-scaled to keep it cheap per pixel. */
export function luminance(r: number, g: number, b: number): number {
  return (r * 77 + g * 150 + b * 29) >> 8;
}

/** Brightness of each cell of a downscaled copy of the frame, from its RGBA. */
export function brightnessGrid(data: Uint8ClampedArray, cells: number): Float32Array {
  const grid = new Float32Array(cells);
  for (let cell = 0, pixel = 0; cell < cells; cell += 1, pixel += 4) {
    grid[cell] = luminance(data[pixel], data[pixel + 1], data[pixel + 2]);
  }
  return grid;
}

/** Smooths a grid in place, so a hard shadow edge does not become a seam. */
export function blurGrid(
  grid: Float32Array,
  width: number,
  height: number,
  passes: number,
): Float32Array {
  let current: Float32Array = grid;
  let next: Float32Array = new Float32Array(grid.length);

  for (let pass = 0; pass < passes; pass += 1) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let sum = 0;
        let count = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          const sy = y + dy;
          if (sy < 0 || sy >= height) continue;
          for (let dx = -1; dx <= 1; dx += 1) {
            const sx = x + dx;
            if (sx < 0 || sx >= width) continue;
            sum += current[sy * width + sx];
            count += 1;
          }
        }
        next[y * width + x] = sum / count;
      }
    }
    const swap = current;
    current = next;
    next = swap;
  }

  if (current !== grid) {
    grid.set(current);
  }
  return grid;
}

/** The multiplier each cell needs to reach the target exposure. */
export function gainGrid(brightness: Float32Array): Float32Array {
  const gains = new Float32Array(brightness.length);
  for (let cell = 0; cell < brightness.length; cell += 1) {
    const local = Math.max(FLOOR, brightness[cell]);
    gains[cell] = Math.min(MAX_GAIN, Math.max(1, TARGET / local));
  }
  return gains;
}

/** The largest gain in a grid: what the frame as a whole was lifted by. */
export function maxGain(gains: Float32Array): number {
  let top = 1;
  for (let cell = 0; cell < gains.length; cell += 1) {
    top = Math.max(top, gains[cell]);
  }
  return top;
}

/** Bilinear lookup into a grid, in cell coordinates. */
export function sampleGrid(
  grid: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  const cx = Math.min(Math.max(x, 0), width - 1);
  const cy = Math.min(Math.max(y, 0), height - 1);
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const tx = cx - x0;
  const ty = cy - y0;

  const top = grid[y0 * width + x0] * (1 - tx) + grid[y0 * width + x1] * tx;
  const bottom = grid[y1 * width + x0] * (1 - tx) + grid[y1 * width + x1] * tx;
  return top * (1 - ty) + bottom * ty;
}

/**
 * Multiplies each pixel by its local gain, in place. Returns whether anything
 * was lifted, so a frame that was already fine is never rebuilt.
 */
export function liftImage(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  gains: Float32Array,
  gridW: number,
  gridH: number,
): boolean {
  const stepX = gridW / width;
  const stepY = gridH / height;
  let lifted = false;

  for (let y = 0; y < height; y += 1) {
    const gy = (y + 0.5) * stepY - 0.5;
    for (let x = 0; x < width; x += 1) {
      const gain = sampleGrid(gains, gridW, gridH, (x + 0.5) * stepX - 0.5, gy);
      if (gain <= 1.001) {
        continue;
      }
      const pixel = (y * width + x) * 4;
      data[pixel] = data[pixel] * gain;
      data[pixel + 1] = data[pixel + 1] * gain;
      data[pixel + 2] = data[pixel + 2] * gain;
      lifted = true;
    }
  }

  return lifted;
}

/** Turns a dim camera frame into one the landmark model can read. */
export class LowLight {
  #canvas: HTMLCanvasElement | null = null;
  #ctx: CanvasRenderingContext2D | null = null;
  #thumb: HTMLCanvasElement | null = null;
  #thumbCtx: CanvasRenderingContext2D | null = null;
  #gain = 1;

  /** Lift applied to the last frame; 1 when it was passed through. */
  get gain(): number {
    return this.#gain;
  }

  /**
   * Returns the picture to run the model on: the frame itself when it is well
   * enough lit, or a lifted copy on this object's canvas otherwise.
   */
  prepare(frame: ImageBitmap): FrameSource {
    this.#gain = 1;
    if (!this.#ensure(frame.width, frame.height)) {
      return frame;
    }

    const thumbCtx = this.#thumbCtx!;
    thumbCtx.drawImage(frame, 0, 0, GRID_W, GRID_H);
    const thumb = thumbCtx.getImageData(0, 0, GRID_W, GRID_H);
    const brightness = blurGrid(
      brightnessGrid(thumb.data, GRID_W * GRID_H),
      GRID_W,
      GRID_H,
      BLUR_PASSES,
    );
    const gains = gainGrid(brightness);
    blurGrid(gains, GRID_W, GRID_H, BLUR_PASSES);

    const top = maxGain(gains);
    if (top < MIN_LIFT) {
      return frame;
    }

    const canvas = this.#canvas!;
    const ctx = this.#ctx!;
    ctx.drawImage(frame, 0, 0);
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    if (!liftImage(image.data, canvas.width, canvas.height, gains, GRID_W, GRID_H)) {
      return frame;
    }
    ctx.putImageData(image, 0, 0);
    this.#gain = top;
    return canvas;
  }

  /** Sizes the offscreen canvases; false when 2D drawing is unavailable. */
  #ensure(width: number, height: number): boolean {
    if (!this.#canvas) {
      this.#canvas = document.createElement("canvas");
      this.#ctx = this.#canvas.getContext("2d", { willReadFrequently: true });
      this.#thumb = document.createElement("canvas");
      this.#thumb.width = GRID_W;
      this.#thumb.height = GRID_H;
      this.#thumbCtx = this.#thumb.getContext("2d", { willReadFrequently: true });
    }
    if (!this.#ctx || !this.#thumbCtx) {
      return false;
    }
    if (this.#canvas.width !== width || this.#canvas.height !== height) {
      this.#canvas.width = width;
      this.#canvas.height = height;
    }
    return true;
  }
}
