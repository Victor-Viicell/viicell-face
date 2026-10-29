/**
 * The tracking camera preview.
 *
 * Shows the picture the landmarker just saw, with its landmarks over it and the
 * values read from them. Toggled with `T`.
 *
 * It is a DOM canvas on purpose: the virtual camera is fed by a readback of the
 * Pixi stage, so a rigging aid drawn here can never reach another app.
 */

import type { Landmark } from "./landmarks";
import type { TrackReading } from "./tracker";
import { FULL_CROP, boxOf, easeCrop, frameAround, type Crop } from "./crop";
import type { FrameSource } from "./lowlight";
import { MOCHA } from "./palette";

interface Point {
  x: number;
  y: number;
}

/** A pair of landmarks to join with a line. */
type Connection = readonly [number, number];

/** The preview is a quarter of the 640×480 capture. */
const WIDTH = 320;
const HEIGHT = 240;

// Overlay colours, from the same palette the face paints with.
const POINT_COLOR = "rgba(137, 220, 235, 0.35)";
const MESH_COLOR = "rgba(137, 220, 235, 0.75)";
const IRIS_COLOR = MOCHA.blue;
const BROW_COLOR = "rgba(249, 226, 175, 0.9)";
const MOUTH_COLOR = "rgba(245, 194, 231, 0.9)";
const TEXT_COLOR = MOCHA.text;
const WARN_COLOR = MOCHA.peach;

const VALUE_FONT = "9px ui-monospace, SFMono-Regular, Menlo, monospace";
const MESSAGE_FONT = "10px ui-monospace, SFMono-Regular, Menlo, monospace";

/**
 * Landmark groups, from MediaPipe's FaceMesh connection tables.
 *
 * The image is not mirrored, so the subject's right eye (group 33) sits on the
 * left of the picture — the same eye the rig calls left.
 */
const FACE_OVAL: readonly Connection[] = [
  [10, 338], [338, 297], [297, 332], [332, 284], [284, 251], [251, 389],
  [389, 356], [356, 454], [454, 323], [323, 361], [361, 288], [288, 397],
  [397, 365], [365, 379], [379, 378], [378, 400], [400, 377], [377, 152],
  [152, 148], [148, 176], [176, 149], [149, 150], [150, 136], [136, 172],
  [172, 58], [58, 132], [132, 93], [93, 234], [234, 127], [127, 162],
  [162, 21], [21, 54], [54, 103], [103, 67], [67, 109], [109, 10],
];

/** Viewer's left lid: the group `landmarks.ts` measures for `blinkLeft`. */
const EYE_LEFT: readonly Connection[] = [
  [33, 7], [7, 163], [163, 144], [144, 145], [145, 153], [153, 154],
  [154, 155], [155, 133], [33, 246], [246, 161], [161, 160], [160, 159],
  [159, 158], [158, 157], [157, 173], [173, 133],
];
const EYE_RIGHT: readonly Connection[] = [
  [263, 249], [249, 390], [390, 373], [373, 374], [374, 380], [380, 381],
  [381, 382], [382, 362], [263, 466], [466, 388], [388, 387], [387, 386],
  [386, 385], [385, 384], [384, 398], [398, 362],
];

/** Irises: 469–472 is the subject's right one, on the left of the picture. */
const IRIS_LEFT: readonly Connection[] = [
  [469, 470], [470, 471], [471, 472], [472, 469],
];
const IRIS_RIGHT: readonly Connection[] = [
  [474, 475], [475, 476], [476, 477], [477, 474],
];

const BROW_LEFT: readonly Connection[] = [
  [46, 53], [53, 52], [52, 65], [65, 55], [70, 63], [63, 105], [105, 66], [66, 107],
];
const BROW_RIGHT: readonly Connection[] = [
  [276, 283], [283, 282], [282, 295], [295, 285], [300, 293], [293, 334],
  [334, 296], [296, 336],
];

const LIPS: readonly Connection[] = [
  [61, 146], [146, 91], [91, 181], [181, 84], [84, 17], [17, 314],
  [314, 405], [405, 321], [321, 375], [375, 291], [61, 185], [185, 40],
  [40, 39], [39, 37], [37, 0], [0, 267], [267, 269], [269, 270],
  [270, 409], [409, 291], [78, 95], [95, 88], [88, 178], [178, 87],
  [87, 14], [14, 317], [317, 402], [402, 318], [318, 324], [324, 308],
  [78, 191], [191, 80], [80, 81], [81, 82], [82, 13], [13, 312],
  [312, 311], [311, 310], [310, 415], [415, 308],
];

/** Midpoints of the corners, for the `L`/`R` labels and the iris dots. */
const EYE_LEFT_CORNERS = [33, 133] as const;
const EYE_RIGHT_CORNERS = [263, 362] as const;
const IRIS_LEFT_CENTRE = [469, 470, 471, 472] as const;
const IRIS_RIGHT_CENTRE = [474, 475, 476, 477] as const;

const fixed = (value: number) => value.toFixed(2);
const signed = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;

/** Frames without a face before the preview zooms back out. */
const FACE_LOST_FRAMES = 3;

/** Mint while the lid is open, amber halfway, red when it is shut. */
function lidColor(closure: number): string {
  const shade = Math.min(1, Math.max(0, closure));
  return `hsl(${Math.round(150 - 150 * shade)} 90% 62%)`;
}

export class CameraDebugView {
  readonly #canvas: HTMLCanvasElement;
  readonly #ctx: CanvasRenderingContext2D;
  #visible = false;
  /** True while frames are drawn, false while a note is shown instead. */
  #live = false;
  #message = "waiting for the camera…";
  /** What the picture is framing; null until the first frame arrives. */
  #crop: Crop | null = null;
  #cropTarget: Crop = FULL_CROP;
  /** Frames in a row with no face in them. */
  #missed = 0;
  /** When the last frame was drawn, for the crop easing. */
  #drawnAt = 0;

  constructor(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("the camera preview needs a 2D canvas");
    }

    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    canvas.hidden = true;

    this.#canvas = canvas;
    this.#ctx = ctx;
    this.#paintMessage();
  }

  get visible(): boolean {
    return this.#visible;
  }

  /** Shows or hides the preview; returns whether it is now visible. */
  setVisible(visible: boolean): boolean {
    if (visible === this.#visible) {
      return this.#visible;
    }

    this.#visible = visible;
    this.#canvas.hidden = !visible;
    if (visible && !this.#live) {
      this.#paintMessage();
    }
    return this.#visible;
  }

  /** Shows or hides the preview; returns whether it is now visible. */
  toggle(): boolean {
    return this.setVisible(!this.#visible);
  }

  /**
   * Replaces the picture with a note — the camera is off, still opening, or
   * failed. New frames overwrite it as soon as one arrives.
   */
  showMessage(message: string): void {
    this.#message = message;
    this.#live = false;
    // The next frame starts from its own crop instead of easing down from the
    // one that was on screen before the camera stopped.
    this.#crop = null;
    this.#cropTarget = FULL_CROP;
    this.#missed = 0;
    this.#drawnAt = 0;
    if (this.#visible) {
      this.#paintMessage();
    }
  }

  /** Draws one frame and, when there was a face in it, its landmarks. */
  draw(frame: FrameSource, reading: TrackReading | null): void {
    if (!this.#visible) {
      return;
    }

    const ctx = this.#ctx;
    const now = performance.now();
    const dt = this.#drawnAt === 0 ? 0 : Math.min(0.25, (now - this.#drawnAt) / 1000);
    this.#drawnAt = now;

    if (reading) {
      const box = boxOf(reading.landmarks);
      this.#cropTarget = box
        ? frameAround(box, (WIDTH / HEIGHT) * (frame.height / frame.width))
        : FULL_CROP;
      this.#missed = 0;
    } else {
      // A single dropped frame is not worth zooming out for; a face that has
      // really gone should give the whole picture back.
      this.#missed += 1;
      if (this.#missed >= FACE_LOST_FRAMES) {
        this.#cropTarget = FULL_CROP;
      }
    }

    this.#crop =
      this.#crop === null ? this.#cropTarget : easeCrop(this.#crop, this.#cropTarget, dt);
    const crop = this.#crop;

    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    ctx.fillStyle = MOCHA.crust;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.drawImage(
      frame,
      crop.x * frame.width,
      crop.y * frame.height,
      crop.w * frame.width,
      crop.h * frame.height,
      0,
      0,
      WIDTH,
      HEIGHT,
    );

    if (reading === null) {
      this.#banner("no face in view", WARN_COLOR);
    } else {
      this.#drawFace(reading, crop);
      this.#drawValues(reading);
    }

    this.#live = true;
  }

  #drawFace(reading: TrackReading, crop: Crop): void {
    const ctx = this.#ctx;
    const at = (index: number): Point | null => {
      const landmark: Landmark | undefined = reading.landmarks[index];
      return landmark
        ? {
            x: ((landmark.x - crop.x) / crop.w) * WIDTH,
            y: ((landmark.y - crop.y) / crop.h) * HEIGHT,
          }
        : null;
    };

    // Every point, faintly: the whole mesh moving is the clearest sign the model
    // is following the face rather than looking at a stale picture.
    ctx.fillStyle = POINT_COLOR;
    for (const landmark of reading.landmarks) {
      const x = ((landmark.x - crop.x) / crop.w) * WIDTH;
      const y = ((landmark.y - crop.y) / crop.h) * HEIGHT;
      ctx.fillRect(x - 0.5, y - 0.5, 1, 1);
    }

    this.#connections(FACE_OVAL, at, MESH_COLOR, 1);
    this.#connections(LIPS, at, MOUTH_COLOR, 1);
    this.#connections(BROW_LEFT, at, BROW_COLOR, 1.2);
    this.#connections(BROW_RIGHT, at, BROW_COLOR, 1.2);

    // Each lid in its own colour, so a wink is unmistakable.
    this.#connections(EYE_LEFT, at, lidColor(reading.sample.blinkLeft), 1.4);
    this.#connections(EYE_RIGHT, at, lidColor(reading.sample.blinkRight), 1.4);
    this.#connections(IRIS_LEFT, at, IRIS_COLOR, 1.2);
    this.#connections(IRIS_RIGHT, at, IRIS_COLOR, 1.2);

    this.#dot(this.#centre(IRIS_LEFT_CENTRE, at), IRIS_COLOR);
    this.#dot(this.#centre(IRIS_RIGHT_CENTRE, at), IRIS_COLOR);
    this.#label(this.#centre(EYE_LEFT_CORNERS, at), "L", 0, -9);
    this.#label(this.#centre(EYE_RIGHT_CORNERS, at), "R", 0, -9);
  }

  #drawValues(reading: TrackReading): void {
    const ctx = this.#ctx;
    const { sample, raw, calibration } = reading;
    const status =
      calibration.step !== null
        ? "calibrating"
        : calibration.calibrated
          ? "calibrated"
          : "not calibrated";

    const lines = [
      `L score ${fixed(raw.blinkLeft)} · lid ${fixed(raw.lidLeft)} · close ${fixed(sample.blinkLeft)}`,
      `R score ${fixed(raw.blinkRight)} · lid ${fixed(raw.lidRight)} · close ${fixed(sample.blinkRight)}`,
      `wide L ${fixed(raw.eyeWideLeft)} R ${fixed(raw.eyeWideRight)} · pose ${fixed(sample.eyeWide)}`,
      `cheek L ${fixed(sample.cheekLeft)} R ${fixed(sample.cheekRight)}` +
        ` · squint L ${fixed(raw.cheekSquintLeft)} R ${fixed(raw.cheekSquintRight)}`,
      `smile L ${fixed(raw.smileLeft)} R ${fixed(raw.smileRight)}` +
        ` · brow L ${fixed(sample.browLeft)} R ${fixed(sample.browRight)}`,
      `mouth open ${fixed(sample.mouthOpen)} · width ${fixed(sample.mouthWidth)}` +
        ` · pucker ${fixed(sample.mouthPucker)} · jaw ${fixed(raw.jawOpen)}` +
        ` · drop ${fixed(raw.mouthDrop)}`,
      `mouth happy L ${fixed(sample.mouthHappyLeft)} R ${fixed(sample.mouthHappyRight)}` +
        ` · sad L ${fixed(sample.mouthSadLeft)} R ${fixed(sample.mouthSadRight)}`,
      `mouth shift ${signed(sample.mouthShiftX)} ${signed(sample.mouthShiftY)}` +
        ` · tilt ${signed(sample.mouthTilt)}`,
      `head turn ${signed(sample.headYaw)} ${signed(sample.headPitch)}`,
      `look ${signed(sample.lookX)} ${signed(sample.lookY)}` +
        ` · eye ${signed(raw.lookH)} ${signed(raw.lookV)}` +
        ` · head ${signed(sample.x)} ${signed(sample.y)}` +
        ` · ${status}`,
    ];

    const lineHeight = 11;
    const barHeight = lines.length * lineHeight + 9;
    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
    ctx.fillRect(0, HEIGHT - barHeight, WIDTH, barHeight);

    ctx.fillStyle = TEXT_COLOR;
    ctx.font = VALUE_FONT;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    lines.forEach((line, index) => {
      ctx.fillText(line, 6, HEIGHT - barHeight + 12 + index * lineHeight);
    });
  }

  #paintMessage(): void {
    const ctx = this.#ctx;
    ctx.fillStyle = MOCHA.crust;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    ctx.font = MESSAGE_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = WARN_COLOR;

    const lines = wrapText(ctx, this.#message, WIDTH - 28);
    const lineHeight = 14;
    const start = HEIGHT / 2 - ((lines.length - 1) * lineHeight) / 2;
    lines.forEach((line, index) => {
      ctx.fillText(line, WIDTH / 2, start + index * lineHeight);
    });
  }

  /** A note across the middle, over whatever is already drawn. */
  #banner(text: string, color: string): void {
    const ctx = this.#ctx;
    ctx.font = MESSAGE_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const width = ctx.measureText(text).width + 16;
    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
    ctx.fillRect((WIDTH - width) / 2, HEIGHT / 2 - 11, width, 22);
    ctx.fillStyle = color;
    ctx.fillText(text, WIDTH / 2, HEIGHT / 2);
  }

  #connections(
    pairs: readonly Connection[],
    at: (index: number) => Point | null,
    color: string,
    width: number,
  ): void {
    const ctx = this.#ctx;
    ctx.beginPath();
    for (const [a, b] of pairs) {
      const from = at(a);
      const to = at(b);
      if (!from || !to) {
        continue;
      }
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = "round";
    ctx.stroke();
  }

  #centre(indices: readonly number[], at: (index: number) => Point | null): Point | null {
    let x = 0;
    let y = 0;
    let count = 0;
    for (const index of indices) {
      const point = at(index);
      if (point) {
        x += point.x;
        y += point.y;
        count += 1;
      }
    }
    return count === 0 ? null : { x: x / count, y: y / count };
  }

  #dot(point: Point | null, color: string): void {
    if (!point) {
      return;
    }
    const ctx = this.#ctx;
    ctx.beginPath();
    ctx.arc(point.x, point.y, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = "rgba(0, 0, 0, 0.6)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  #label(point: Point | null, text: string, dx: number, dy: number): void {
    if (!point) {
      return;
    }
    const ctx = this.#ctx;
    ctx.font = "600 10px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
    ctx.fillText(text, point.x + dx + 1, point.y + dy + 1);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(text, point.x + dx, point.y + dy);
  }
}

/** Splits a note into lines that fit the preview. */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";

  for (const word of text.split(/\s+/)) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(candidate).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }

  if (line) {
    lines.push(line);
  }
  return lines.length > 0 ? lines : [""];
}
