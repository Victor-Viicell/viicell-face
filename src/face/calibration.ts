/**
 * The guided calibration.
 *
 * The pose maths needs this person's range, not an average one: how far the lids
 * travel, how high the blink score goes, how wide the smile is, and how far the
 * head and the eyes move the look across the monitor. The flow below holds one
 * pose at a time and is advanced by hand, so the person can settle into the pose
 * while it is measured.
 *
 * It is a pure state machine — the tracker hands it readings and the window
 * advances it — so the sequence can be tested without a camera or a pointer.
 */

import {
  NO_CALIBRATION,
  fitGaze,
  medianOf,
  percentileOf,
  type Calibration,
  type GazeTracePoint,
  type RawSample,
} from "./landmarks";
import type { ScreenPoint } from "../anchor";

export type CalibrationStep =
  | "neutral"
  | "lookTopLeft"
  | "lookTopRight"
  | "lookBottomRight"
  | "lookBottomLeft"
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
    id: "lookTopLeft",
    instruction: "Look at the green ring in the top left corner and hold your gaze there",
  },
  {
    id: "lookTopRight",
    instruction: "Look at the green ring in the top right corner and hold your gaze there",
  },
  {
    id: "lookBottomRight",
    instruction: "Look at the green ring in the bottom right corner and hold your gaze there",
  },
  {
    id: "lookBottomLeft",
    instruction: "Look at the green ring in the bottom left corner and hold your gaze there",
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

/**
 * Monitor points the pupil calibration looks at, 0..1 across the screen. The
 * margin keeps the gaze off the exact bezel while still close to the corner.
 */
const CORNER_INSET = 0.05;
const LOOK_TARGETS: Partial<Record<CalibrationStep, ScreenPoint>> = {
  lookTopLeft: { u: CORNER_INSET, v: CORNER_INSET },
  lookTopRight: { u: 1 - CORNER_INSET, v: CORNER_INSET },
  lookBottomRight: { u: 1 - CORNER_INSET, v: 1 - CORNER_INSET },
  lookBottomLeft: { u: CORNER_INSET, v: 1 - CORNER_INSET },
};
/**
 * Where each look step asks the person to aim, for the on-screen mark. The
 * neutral pose is the middle of the screen; unlike the corners it is not a fit
 * point, it is the zero the other four are measured against.
 */
const LOOK_AIMS: Partial<Record<CalibrationStep, ScreenPoint>> = {
  neutral: { u: 0.5, v: 0.5 },
  ...LOOK_TARGETS,
};

/**
 * The monitor point a look step is aimed at, for drawing its mark; null for a
 * step that is not about where the eyes point.
 */
export function lookTarget(step: CalibrationStep | null): ScreenPoint | null {
  return step ? (LOOK_AIMS[step] ?? null) : null;
}

export type CalibrationKind = "mouth" | "eyes" | "pupils";

/** A named subset of the poses, run from its own button. */
export interface CalibrationPreset {
  /** Which part of the face it measures; null for the full sequence. */
  kind: CalibrationKind | null;
  /** Shown in the panel title. */
  label: string;
  steps: readonly CalibrationStepDef[];
}

const STEP_BY_ID = new Map(CALIBRATION_STEPS.map((step) => [step.id, step]));

/** The preset for each button; every run starts from the neutral pose. */
export const CALIBRATION_PRESETS: Record<CalibrationKind, CalibrationPreset> = {
  mouth: {
    kind: "mouth",
    label: "Mouth",
    steps: (["neutral", "smile", "sad", "jaw"] as const).map((id) => STEP_BY_ID.get(id)!),
  },
  eyes: {
    kind: "eyes",
    label: "Eyes",
    steps: (["neutral", "closedLeft", "closedRight"] as const).map((id) => STEP_BY_ID.get(id)!),
  },
  pupils: {
    kind: "pupils",
    label: "Pupils",
    steps: (
      ["neutral", "lookTopLeft", "lookTopRight", "lookBottomRight", "lookBottomLeft"] as const
    ).map((id) => STEP_BY_ID.get(id)!),
  },
};

/** The whole sequence in one run; the flow defaults to it and the tests use it. */
const FULL_PRESET: CalibrationPreset = {
  kind: null,
  label: "Face",
  steps: CALIBRATION_STEPS,
};

/** Readings a static pose needs before Next is accepted (~0.3 s at 30 fps). */
export const MIN_STEP_SAMPLES = 8;
/** Readings kept per static pose; holding longer changes nothing. */
export const MAX_STEP_SAMPLES = 24;
/**
 * Readings ignored right after Start, so the movement into the pose is not
 * measured. This is what lets the person move their eyes to a corner after
 * pressing Start without that travel being read as the pose.
 */
export const SETTLE_SAMPLES = 12;

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
  "eyeWideLeft",
  "eyeWideRight",
  "lookH",
  "lookV",
  "smileLeft",
  "smileRight",
  "frownLeft",
  "frownRight",
  "jawOpen",
  "mouthGap",
  "mouthDrop",
  "mouthPucker",
  "mouthX",
  "mouthY",
  "mouthTilt",
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

export interface CalibrationStepProgress {
  /** Which preset is running; null when the flow is not running. */
  kind: CalibrationKind | null;
  /** Name of the preset, for the panel title. */
  label: string;
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
  /** The four corner looks, kept for the gaze fit and the open-eye reference. */
  #trace: GazeTracePoint[] = [];
  /** The poses being run, and the calibration this run starts from. */
  #preset: CalibrationPreset = FULL_PRESET;
  #base: Calibration = NO_CALIBRATION;

  /**
   * Starts a run, waiting on Start for the first pose.
   *
   * Only what the preset measures is replaced; everything else is copied from
   * `base`, so running one part of the face leaves the others as they were.
   */
  restart(preset: CalibrationPreset = FULL_PRESET, base: Calibration = NO_CALIBRATION): void {
    this.#running = true;
    this.#armed = false;
    this.#settle = 0;
    this.#index = 0;
    this.#samples = [];
    this.#measured.clear();
    this.#trace = [];
    this.#preset = preset;
    this.#base = base;
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
    const step = this.#running ? this.#preset.steps[this.#index] : undefined;
    if (!step) {
      return {
        kind: null,
        label: "",
        step: null,
        instruction: "",
        index: 0,
        total: this.#preset.steps.length,
        armed: false,
        settling: false,
        samples: 0,
        filled: 0,
        ready: false,
        hint: "",
      };
    }

    const samples = this.#samples.length;
    const enough = samples >= MIN_STEP_SAMPLES;
    // A corner look is captured before the person has to look back at the panel
    // to press Next, so it stops at the minimum; the other poses can be held
    // while the button is pressed and keep collecting.
    const target = LOOK_TARGETS[step.id] ? MIN_STEP_SAMPLES : MAX_STEP_SAMPLES;

    return {
      kind: this.#preset.kind,
      label: this.#preset.label,
      step: step.id,
      instruction: step.instruction,
      index: this.#index + 1,
      total: this.#preset.steps.length,
      armed: this.#armed,
      settling: this.#armed && this.#settle > 0,
      samples,
      filled: this.#armed ? Math.min(1, samples / target) : 0,
      ready: this.#armed && enough,
      hint: `hold the pose · ${samples} frame${samples === 1 ? "" : "s"}`,
    };
  }

  /** Records a reading for the pose being held; ignored until Start. */
  add(raw: RawSample): void {
    if (!this.#running || !this.#armed) {
      return;
    }
    if (this.#settle > 0) {
      this.#settle -= 1;
      return;
    }

    const step = this.#preset.steps[this.#index];
    const cap = step && LOOK_TARGETS[step.id] ? MIN_STEP_SAMPLES : MAX_STEP_SAMPLES;
    if (this.#samples.length < cap) {
      this.#samples.push(raw);
    }
  }

  /**
   * Stores the pose that was held and moves to the next one. Returns the
   * finished calibration when the last pose is done.
   */
  next(): Calibration | null {
    const step = this.#running ? this.#preset.steps[this.#index] : undefined;
    if (!step || !this.#armed) {
      return null;
    }

    if (this.#samples.length > 0) {
      const median = medianSample(this.#samples);
      const target = LOOK_TARGETS[step.id];
      if (target) {
        // A corner look becomes one fit point: the held pose paired with the
        // monitor point it was looking at.
        this.#trace.push({ raw: median, u: target.u, v: target.v });
      } else {
        this.#measured.set(step.id, median);
      }
    }
    this.#samples = [];
    this.#armed = false;
    this.#settle = 0;
    this.#index += 1;

    if (this.#index < this.#preset.steps.length) {
      return null;
    }

    this.#running = false;
    return this.#build(this.#base);
  }

  /**
   * The finished run, layered over `base`.
   *
   * A preset measures only some channels, so the rest are copied from the
   * calibration in use. That is what lets the mouth, eyes and pupil runs be
   * redone separately without wiping each other.
   */
  #build(base: Calibration): Calibration {
    const at = (id: CalibrationStep) => this.#measured.get(id);
    const measuredNeutral = at("neutral");
    const neutral = measuredNeutral ? { ...measuredNeutral, calibrated: true } : base.neutral;
    const trace = this.#trace;
    const measuredTrace = trace.length > 0;
    // The trace is one long take with the eyes open and looking all over the
    // screen. Percentiles read its edge without letting a blink define the open
    // pose: the blink score is taken low (open eyes score low) and the lid gap
    // from the narrow quarter (looking down narrows it, but a blink sits below
    // that). Without a new trace, keep the open-eye reference already measured,
    // or fall back to the new neutral.
    const scoreLeft = measuredTrace
      ? percentileOf(trace.map((point) => point.raw.blinkLeft), 0.15)
      : base.open.scoreLeft;
    const scoreRight = measuredTrace
      ? percentileOf(trace.map((point) => point.raw.blinkRight), 0.15)
      : base.open.scoreRight;
    const lidLeft = measuredTrace
      ? percentileOf(trace.map((point) => point.raw.lidLeft), 0.25)
      : base.open.lidLeft;
    const lidRight = measuredTrace
      ? percentileOf(trace.map((point) => point.raw.lidRight), 0.25)
      : base.open.lidRight;
    const smile = at("smile");
    const sad = at("sad");
    const jaw = at("jaw");
    const closedLeft = at("closedLeft");
    const closedRight = at("closedRight");

    return {
      neutral,
      // Each eye is measured on its own: the shut reading for a side comes from
      // the pose that closed that eye, so a wink and a full blink both fit the
      // same lid. A run without that pose keeps the side already measured.
      shut: {
        scoreLeft: closedLeft ? closedLeft.blinkLeft : base.shut.scoreLeft,
        lidLeft: closedLeft ? closedLeft.lidLeft : base.shut.lidLeft,
        scoreRight: closedRight ? closedRight.blinkRight : base.shut.scoreRight,
        lidRight: closedRight ? closedRight.lidRight : base.shut.lidRight,
      },
      open: {
        scoreLeft: Math.max(neutral.blinkLeft, scoreLeft),
        lidLeft: Math.min(neutral.lidLeft, lidLeft),
        scoreRight: Math.max(neutral.blinkRight, scoreRight),
        lidRight: Math.min(neutral.lidRight, lidRight),
      },
      gaze: measuredTrace ? fitGaze(trace, neutral) : base.gaze,
      cheek: smile
        ? {
            smileLeft: smile.smileLeft,
            smileRight: smile.smileRight,
            squintLeft: smile.cheekSquintLeft,
            squintRight: smile.cheekSquintRight,
          }
        : base.cheek,
      jawMax: jaw ? jaw.jawOpen : base.jawMax,
      mouthGapMax: jaw ? jaw.mouthGap : base.mouthGapMax,
      mouthDropMax: sad ? sad.mouthDrop : base.mouthDropMax,
      browMaxLeft: sad ? sad.browDownLeft : base.browMaxLeft,
      browMaxRight: sad ? sad.browDownRight : base.browMaxRight,
      frownMaxLeft: sad ? sad.frownLeft : base.frownMaxLeft,
      frownMaxRight: sad ? sad.frownRight : base.frownMaxRight,
    };
  }
}
