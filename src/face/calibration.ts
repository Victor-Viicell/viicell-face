/**
 * The guided calibration.
 *
 * The pose maths needs this person's range, not an average one: how far the lids
 * travel, how high the blink score goes, how wide the smile is, and how far the
 * head and the eyes move the look across the monitor. The flow below holds one
 * pose at a time and is advanced by hand, so the person can settle into the pose
 * while it is measured.
 *
 * It is a pure state machine — the tracker hands it readings (and, for the
 * cursor follow, the pointer position), and the window hands it `next()` — so the
 * sequence can be tested without a camera or a pointer.
 */

import {
  NEUTRAL_UNMEASURED,
  fitGaze,
  medianOf,
  percentileOf,
  type Calibration,
  type EyeRange,
  type GazeTracePoint,
  type RawSample,
} from "./landmarks";
import type { ScreenPoint } from "../anchor";

export type CalibrationStep =
  | "neutral"
  | "follow"
  | "smile"
  | "sad"
  | "jaw"
  | "closedLeft"
  | "closedRight";

export interface CalibrationStepDef {
  id: CalibrationStep;
  /** Shown above the camera while the pose is held. */
  instruction: string;
}

export const CALIBRATION_STEPS: readonly CalibrationStepDef[] = [
  { id: "neutral", instruction: "Look at the middle of the screen and relax, with your mouth closed" },
  {
    id: "follow",
    instruction: "Move the mouse slowly to every corner and follow it with your eyes",
  },
  { id: "smile", instruction: "Smile as wide as you can, with your eyes too" },
  { id: "sad", instruction: "Look sad: pull your mouth corners and your brows down" },
  { id: "jaw", instruction: "Open your mouth as wide as you comfortably can" },
  {
    id: "closedLeft",
    instruction: "Close the eye labelled L and hold it shut, keeping the other one open",
  },
  {
    id: "closedRight",
    instruction: "Close the eye labelled R and hold it shut, keeping the other one open",
  },
];

/** Readings a static pose needs before Next is accepted (~0.5 s). */
export const MIN_STEP_SAMPLES = 8;
/** Readings kept per static pose; holding longer changes nothing. */
export const MAX_STEP_SAMPLES = 24;
/**
 * Readings ignored right after Start, so the movement into the pose is not
 * measured. The follow step needs this most: the pointer has to be picked up and
 * set moving after the button is pressed.
 */
export const SETTLE_SAMPLES = 12;

/**
 * Cursor readings the follow needs. At the camera's 15 Hz this is about four
 * seconds of tracing, enough that a blinks' worth of frames cannot steer it.
 */
export const MIN_FOLLOW_SAMPLES = 60;
/** The trace stops growing here; holding longer changes nothing. */
export const MAX_FOLLOW_SAMPLES = 240;
/**
 * How far out the cursor has to travel from the middle, per direction, for the
 * fit to cover the screen. Staying near the middle would leave the edges as an
 * extrapolation, which is exactly where accuracy was worst.
 */
const FOLLOW_REACH = 0.3;

/** The fields of a reading the calibration averages. */
const SAMPLE_FIELDS = [
  "x",
  "y",
  "yaw",
  "pitch",
  "lidLeft",
  "lidRight",
  "blinkLeft",
  "blinkRight",
  "lookH",
  "lookV",
  "smileLeft",
  "smileRight",
  "frownLeft",
  "frownRight",
  "jawOpen",
  "cheekSquintLeft",
  "cheekSquintRight",
  "browDownLeft",
  "browDownRight",
] as const;

/** The median of each field: the pose held during a step, minus the outliers. */
export function medianSample(samples: readonly RawSample[]): RawSample {
  const median = {} as RawSample;
  for (const field of SAMPLE_FIELDS) {
    median[field] = medianOf(samples.map((sample) => sample[field]));
  }
  return median;
}

const eyeRangeOf = (left: RawSample, right: RawSample): EyeRange => ({
  scoreLeft: left.blinkLeft,
  lidLeft: left.lidLeft,
  scoreRight: right.blinkRight,
  lidRight: right.lidRight,
});

/** How much of the screen the cursor has covered, 0..1, per direction. */
export function traceCoverage(trace: readonly GazeTracePoint[]): number {
  if (trace.length === 0) {
    return 0;
  }

  let minU = 1;
  let maxU = 0;
  let minV = 1;
  let maxV = 0;
  for (const { u, v } of trace) {
    minU = Math.min(minU, u);
    maxU = Math.max(maxU, u);
    minV = Math.min(minV, v);
    maxV = Math.max(maxV, v);
  }

  const reach = Math.min(0.5 - minU, maxU - 0.5, 0.5 - minV, maxV - 0.5);
  return Math.min(1, Math.max(0, reach) / FOLLOW_REACH);
}

export interface CalibrationStepProgress {
  /** The pose being held; null when the flow is not running. */
  step: CalibrationStep | null;
  instruction: string;
  /** 1-based number of the pose, or 0 when not running. */
  index: number;
  total: number;
  /** Whether the pose is being collected: nothing is read before Start. */
  armed: boolean;
  /** True while the movement into the pose is still being ignored. */
  settling: boolean;
  /** Readings collected for the pose. */
  samples: number;
  /** 0..1 of the hold, for the bar. */
  filled: number;
  /** Enough readings to move on. */
  ready: boolean;
  /** What the note under the bar should say while collecting. */
  hint: string;
}

export interface CalibrationProgress extends CalibrationStepProgress {
  /** Whether a measured calibration is in use. */
  calibrated: boolean;
}

export class CalibrationFlow {
  #running = false;
  /** Set by Start: the pose on screen is being collected. */
  #armed = false;
  /** Readings still to be ignored while the person moves into the pose. */
  #settle = 0;
  #index = 0;
  #samples: RawSample[] = [];
  #measured = new Map<CalibrationStep, RawSample>();
  /** The cursor trace, kept for the gaze fit and the open-eye reference. */
  #trace: GazeTracePoint[] = [];

  /** Starts the sequence again, waiting on Start for the first pose. */
  restart(): void {
    this.#running = true;
    this.#armed = false;
    this.#settle = 0;
    this.#index = 0;
    this.#samples = [];
    this.#measured.clear();
    this.#trace = [];
  }

  /** Abandons the run; nothing measured so far is applied. */
  cancel(): void {
    this.#running = false;
    this.#armed = false;
    this.#settle = 0;
    this.#index = 0;
    this.#samples = [];
    this.#measured.clear();
    this.#trace = [];
  }

  get running(): boolean {
    return this.#running;
  }

  /**
   * Begins collecting the pose now on screen.
   *
   * The first moments after Start are ignored: a corner of the screen or the
   * pointer has to be reached after the button is pressed, so the movement would
   * otherwise be read as the pose.
   */
  start(): void {
    if (this.#running) {
      this.#armed = true;
      this.#settle = SETTLE_SAMPLES;
    }
  }

  get progress(): CalibrationStepProgress {
    const step = this.#running ? CALIBRATION_STEPS[this.#index] : undefined;
    if (!step) {
      return {
        step: null,
        instruction: "",
        index: 0,
        total: CALIBRATION_STEPS.length,
        armed: false,
        settling: false,
        samples: 0,
        filled: 0,
        ready: false,
        hint: "",
      };
    }

    const follow = step.id === "follow";
    const samples = follow ? this.#trace.length : this.#samples.length;
    const coverage = follow ? traceCoverage(this.#trace) : 0;
    const enough = follow
      ? samples >= MIN_FOLLOW_SAMPLES && coverage >= 1
      : samples >= MIN_STEP_SAMPLES;

    return {
      step: step.id,
      instruction: step.instruction,
      index: this.#index + 1,
      total: CALIBRATION_STEPS.length,
      armed: this.#armed,
      settling: this.#armed && this.#settle > 0,
      samples,
      filled: this.#armed
        ? follow
          ? Math.min(1, Math.min(samples / MIN_FOLLOW_SAMPLES, coverage))
          : Math.min(1, samples / MAX_STEP_SAMPLES)
        : 0,
      ready: this.#armed && enough,
      hint: follow
        ? samples < MIN_FOLLOW_SAMPLES
          ? `follow the cursor · ${samples} points`
          : "keep going, out to the edges"
        : `hold the pose · ${samples} frame${samples === 1 ? "" : "s"}`,
    };
  }

  /**
   * Records a reading for the pose being held; ignored until Start.
   *
   * The follow step needs the pointer to pair the reading with, and drops a
   * reading it has no cursor for: a point without a target would only blur the
   * fit.
   */
  add(raw: RawSample, cursor: ScreenPoint | null = null): void {
    if (!this.#running || !this.#armed) {
      return;
    }
    if (this.#settle > 0) {
      this.#settle -= 1;
      return;
    }

    const step = CALIBRATION_STEPS[this.#index];
    if (step?.id === "follow") {
      if (cursor && this.#trace.length < MAX_FOLLOW_SAMPLES) {
        this.#trace.push({ raw, u: cursor.u, v: cursor.v });
      }
      return;
    }

    if (this.#samples.length < MAX_STEP_SAMPLES) {
      this.#samples.push(raw);
    }
  }

  /**
   * Stores the pose that was held and moves to the next one. Returns the
   * finished calibration when the last pose is done.
   */
  next(): Calibration | null {
    const step = this.#running ? CALIBRATION_STEPS[this.#index] : undefined;
    if (!step || !this.#armed) {
      return null;
    }

    if (step.id !== "follow" && this.#samples.length > 0) {
      this.#measured.set(step.id, medianSample(this.#samples));
    }
    this.#samples = [];
    this.#armed = false;
    this.#settle = 0;
    this.#index += 1;

    if (this.#index < CALIBRATION_STEPS.length) {
      return null;
    }

    this.#running = false;
    return this.#build();
  }

  #build(): Calibration {
    const at = (id: CalibrationStep) => this.#measured.get(id) ?? NEUTRAL_UNMEASURED;
    const neutral = at("neutral");
    const trace = this.#trace;
    // The trace is one long take with the eyes open and looking all over the
    // screen. Percentiles read its edge without letting the blinks inside it
    // (high scores, low gaps) define the open pose.
    const scoreLeft = trace.length
      ? percentileOf(trace.map((point) => point.raw.blinkLeft), 0.85)
      : neutral.blinkLeft;
    const scoreRight = trace.length
      ? percentileOf(trace.map((point) => point.raw.blinkRight), 0.85)
      : neutral.blinkRight;
    const lidLeft = trace.length
      ? percentileOf(trace.map((point) => point.raw.lidLeft), 0.15)
      : neutral.lidLeft;
    const lidRight = trace.length
      ? percentileOf(trace.map((point) => point.raw.lidRight), 0.15)
      : neutral.lidRight;

    return {
      neutral: { ...neutral, calibrated: true },
      // Each eye is measured on its own: the shut reading for a side comes from
      // the pose that closed that eye, so a wink and a full blink both fit the
      // same lid.
      shut: eyeRangeOf(at("closedLeft"), at("closedRight")),
      open: {
        scoreLeft: Math.max(neutral.blinkLeft, scoreLeft),
        lidLeft: Math.min(neutral.lidLeft, lidLeft),
        scoreRight: Math.max(neutral.blinkRight, scoreRight),
        lidRight: Math.min(neutral.lidRight, lidRight),
      },
      gaze: fitGaze(trace, neutral),
      cheek: {
        smileLeft: at("smile").smileLeft,
        smileRight: at("smile").smileRight,
        squintLeft: at("smile").cheekSquintLeft,
        squintRight: at("smile").cheekSquintRight,
      },
      jawMax: at("jaw").jawOpen,
      browMaxLeft: at("sad").browDownLeft,
      browMaxRight: at("sad").browDownRight,
      frownMaxLeft: at("sad").frownLeft,
      frownMaxRight: at("sad").frownRight,
    };
  }
}
