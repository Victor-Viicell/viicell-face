import { describe, expect, test } from "bun:test";
import {
  CALIBRATION_PRESETS,
  CALIBRATION_STEPS,
  CalibrationFlow,
  MAX_STEP_SAMPLES,
  MIN_STEP_SAMPLES,
  SETTLE_SAMPLES,
  medianSample,
  type CalibrationStep,
} from "./calibration";
import { faceSample, ratio, type Calibration, type RawSample } from "./landmarks";

const BASE: RawSample = {
  x: 0.5,
  y: 0.5,
  yaw: 0,
  pitch: 0,
  lidLeft: 0.28,
  lidRight: 0.28,
  blinkLeft: 0.2,
  blinkRight: 0.2,
  eyeWideLeft: 0,
  eyeWideRight: 0,
  lookH: 0,
  lookV: 0,
  smileLeft: 0.1,
  smileRight: 0.1,
  frownLeft: 0,
  frownRight: 0,
  jawOpen: 0,
  mouthGap: 0,
  mouthDrop: 0,
  mouthPucker: 0,
  mouthX: 0,
  mouthY: 0,
  mouthTilt: 0,
  cheekSquintLeft: 0,
  cheekSquintRight: 0,
  browDownLeft: 0.05,
  browDownRight: 0.05,
};

const reading = (fields: Partial<RawSample> = {}): RawSample => ({ ...BASE, ...fields });

/** The raw look a person gives at each monitor corner, in the rig's units. */
const CORNER_LOOKS: Partial<Record<CalibrationStep, Partial<RawSample>>> = {
  lookTopLeft: { lookH: 0.4, lookV: 0.4 },
  lookTopRight: { lookH: -0.4, lookV: 0.4 },
  lookBottomRight: { lookH: -0.4, lookV: -0.4 },
  lookBottomLeft: { lookH: 0.4, lookV: -0.4 },
};

/**
 * Holds the current step, then presses Next.
 *
 * A corner step gets the look that belongs to it, so the fit sees the four
 * corners; every other step is the pose passed in.
 */
function holdStep(flow: CalibrationFlow, pose: Partial<RawSample> = {}): Calibration | null {
  const step = flow.progress.step;
  const held = { ...(step ? CORNER_LOOKS[step] : undefined), ...pose };

  flow.start();
  for (let index = 0; index < SETTLE_SAMPLES; index += 1) {
    flow.add(reading(held));
  }
  for (let index = 0; index < MIN_STEP_SAMPLES; index += 1) {
    flow.add(reading(held));
  }
  return flow.next();
}

/** Runs the whole sequence, returning the finished calibration. */
function runFlow(flow: CalibrationFlow, pose: Partial<RawSample> = {}): Calibration {
  let calibration: Calibration | null = null;
  for (let step = 0; step < CALIBRATION_STEPS.length; step += 1) {
    calibration = holdStep(flow, pose);
  }
  return calibration!;
}

describe("medianSample", () => {
  test("takes the middle reading, so a stray frame cannot set the range", () => {
    const samples = [
      reading({ blinkLeft: 0.2 }),
      reading({ blinkLeft: 0.9 }),
      reading({ blinkLeft: 0.22 }),
    ];

    expect(medianSample(samples).blinkLeft).toBeCloseTo(0.22);
  });
});

describe("CALIBRATION_PRESETS", () => {
  test("splits the poses by the part each button calibrates", () => {
    expect(CALIBRATION_PRESETS.mouth.steps.map((step) => step.id)).toEqual([
      "neutral",
      "smile",
      "sad",
      "jaw",
    ]);
    expect(CALIBRATION_PRESETS.eyes.steps.map((step) => step.id)).toEqual([
      "neutral",
      "closedLeft",
      "closedRight",
    ]);
    expect(CALIBRATION_PRESETS.pupils.steps.map((step) => step.id)).toEqual([
      "neutral",
      "lookTopLeft",
      "lookTopRight",
      "lookBottomRight",
      "lookBottomLeft",
    ]);
  });

  test("runs only the poses of the chosen preset", () => {
    const flow = new CalibrationFlow();
    flow.restart(CALIBRATION_PRESETS.eyes);

    expect(flow.progress.kind).toBe("eyes");
    expect(flow.progress.label).toBe("Eyes");
    expect(flow.progress.total).toBe(3);
    expect(flow.progress.step).toBe("neutral");

    holdStep(flow); // neutral
    expect(flow.progress.step).toBe("closedLeft");
    expect(flow.progress.index).toBe(2);
  });

  test("keeps the parts it did not measure", () => {
    const flow = new CalibrationFlow();
    flow.restart();
    const full = runFlow(flow);

    flow.restart(CALIBRATION_PRESETS.mouth, full);
    holdStep(flow); // neutral
    holdStep(flow, { smileLeft: 0.95, smileRight: 0.95 });
    holdStep(flow, { frownLeft: 0.5, frownRight: 0.5 });
    const mouth = holdStep(flow, { jawOpen: 0.4, mouthGap: 0.15 })!;

    // The mouth was re-measured...
    expect(mouth.cheek.smileLeft).toBeCloseTo(0.95);
    expect(mouth.jawMax).toBeCloseTo(0.4);
    expect(mouth.mouthGapMax).toBeCloseTo(0.15);
    // ...while the eyes and gaze in use are untouched.
    expect(mouth.shut).toEqual(full.shut);
    expect(mouth.open).toEqual(full.open);
    expect(mouth.gaze).toEqual(full.gaze);
  });

  test("keeps the fallback jaw span when the jaw was not measured", () => {
    const flow = new CalibrationFlow();
    flow.restart(CALIBRATION_PRESETS.eyes);
    holdStep(flow); // neutral
    holdStep(flow, { lidLeft: 0.02, blinkLeft: 0.85 });
    const calibration = holdStep(flow, { lidRight: 0.02, blinkRight: 0.85 })!;

    expect(calibration.shut.lidLeft).toBeCloseTo(0.02);
    expect(calibration.shut.lidRight).toBeCloseTo(0.02);
    // No wide-open pose was measured, so the mouth still opens at the fallback
    // span instead of needing a full jaw score.
    expect(calibration.jawMax).toBe(0);
    expect(faceSample(reading({ jawOpen: 0.25 }), calibration).mouthOpen).toBe(1);
  });
});

describe("CalibrationFlow", () => {
  test("waits for Start, then for Next", () => {
    const flow = new CalibrationFlow();
    expect(flow.progress.step).toBeNull();

    flow.restart();
    expect(flow.progress.step).toBe("neutral");
    expect(flow.progress.armed).toBe(false);

    // Nothing is read until Start: the pose must not be captured while the
    // person is still moving into it.
    flow.add(reading());
    expect(flow.progress.samples).toBe(0);
    expect(flow.next()).toBeNull();
    expect(flow.progress.step).toBe("neutral");

    flow.start();
    expect(flow.progress.armed).toBe(true);
    // The movement into the pose is ignored first, so the pose is captured from
    // where the person settled, not from the transition.
    expect(flow.progress.settling).toBe(true);
    for (let index = 0; index < SETTLE_SAMPLES; index += 1) {
      flow.add(reading());
    }
    expect(flow.progress.samples).toBe(0);
    expect(flow.progress.settling).toBe(false);

    for (let index = 0; index < MIN_STEP_SAMPLES; index += 1) {
      flow.add(reading());
    }
    expect(flow.progress.ready).toBe(true);
    // The pose is only left when Next is pressed.
    expect(flow.progress.step).toBe("neutral");

    expect(flow.next()).toBeNull();
    expect(flow.progress.step).toBe("lookTopLeft");
    expect(flow.progress.armed).toBe(false);
    expect(flow.progress.ready).toBe(false);
  });

  test("a corner look only becomes ready after enough readings", () => {
    const flow = new CalibrationFlow();
    flow.restart(CALIBRATION_PRESETS.pupils);
    holdStep(flow); // neutral

    expect(flow.progress.step).toBe("lookTopLeft");
    flow.start();
    for (let index = 0; index < SETTLE_SAMPLES; index += 1) {
      flow.add(reading());
    }
    expect(flow.progress.samples).toBe(0);

    for (let index = 0; index < MIN_STEP_SAMPLES - 1; index += 1) {
      flow.add(reading());
    }
    expect(flow.progress.ready).toBe(false);
    flow.add(reading());
    expect(flow.progress.ready).toBe(true);
  });

  test("keeps only the first readings of a pose", () => {
    const flow = new CalibrationFlow();
    flow.restart();
    flow.start();

    for (let index = 0; index < MAX_STEP_SAMPLES * 2; index += 1) {
      flow.add(reading());
    }

    expect(flow.progress.samples).toBe(MAX_STEP_SAMPLES);
    expect(flow.progress.filled).toBe(1);
  });

  test("ignores readings while it is not running", () => {
    const flow = new CalibrationFlow();
    flow.add(reading());

    expect(flow.progress.step).toBeNull();
    expect(flow.progress.samples).toBe(0);
  });

  test("measures the pose that was held", () => {
    const flow = new CalibrationFlow();
    flow.restart();

    holdStep(flow); // neutral
    holdStep(flow); // lookTopLeft
    holdStep(flow); // lookTopRight
    holdStep(flow); // lookBottomRight
    holdStep(flow); // lookBottomLeft
    holdStep(flow, {
      smileLeft: 0.85,
      smileRight: 0.8,
      cheekSquintLeft: 0.6,
      cheekSquintRight: 0.55,
    });
    holdStep(flow, {
      browDownLeft: 0.7,
      browDownRight: 0.75,
      frownLeft: 0.4,
      frownRight: 0.45,
      mouthDrop: 0.03,
    });
    holdStep(flow, { jawOpen: 0.72 });
    // One eye at a time: each side takes its shut pose from its own step, so
    // the reading of the open eye on the other side is never used.
    holdStep(flow, { lidLeft: 0.02, lidRight: 0.2, blinkLeft: 0.62, blinkRight: 0.3 });
    const calibration = holdStep(flow, {
      lidLeft: 0.21,
      lidRight: 0.03,
      blinkLeft: 0.3,
      blinkRight: 0.64,
    });

    expect(calibration).not.toBeNull();
    expect(calibration!.neutral.calibrated).toBe(true);
    expect(calibration!.shut.lidLeft).toBeCloseTo(0.02);
    expect(calibration!.shut.scoreLeft).toBeCloseTo(0.62);
    expect(calibration!.shut.lidRight).toBeCloseTo(0.03);
    expect(calibration!.shut.scoreRight).toBeCloseTo(0.64);
    expect(calibration!.cheek.smileLeft).toBeCloseTo(0.85);
    expect(calibration!.cheek.smileRight).toBeCloseTo(0.8);
    expect(calibration!.cheek.squintLeft).toBeCloseTo(0.6);
    expect(calibration!.cheek.squintRight).toBeCloseTo(0.55);
    expect(calibration!.browMaxLeft).toBeCloseTo(0.7);
    expect(calibration!.browMaxRight).toBeCloseTo(0.75);
    expect(calibration!.frownMaxLeft).toBeCloseTo(0.4);
    expect(calibration!.frownMaxRight).toBeCloseTo(0.45);
    expect(calibration!.mouthDropMax).toBeCloseTo(0.03);
    expect(calibration!.jawMax).toBeCloseTo(0.72);
    // The trace is taken with the eyes open, so it is the reference for "open".
    expect(calibration!.open.scoreLeft).toBeCloseTo(0.2);
    expect(calibration!.open.lidLeft).toBeCloseTo(0.28);
    expect(calibration!.gaze).not.toBeNull();
    expect(flow.progress.step).toBeNull();
    expect(flow.running).toBe(false);
  });

  test("fits the gaze to the corner looks", () => {
    const flow = new CalibrationFlow();
    flow.restart();
    const calibration = runFlow(flow);

    // The corner looks aim at the top left (u,v 0.05) and the bottom right
    // (u,v 0.95), so the fitted look has to point the same way.
    const topLeft = faceSample(reading({ lookH: 0.4, lookV: 0.4 }), calibration);
    expect(topLeft.lookX).toBeLessThan(-0.5);
    expect(topLeft.lookY).toBeLessThan(-0.5);

    const bottomRight = faceSample(reading({ lookH: -0.4, lookV: -0.4 }), calibration);
    expect(bottomRight.lookX).toBeGreaterThan(0.5);
    expect(bottomRight.lookY).toBeGreaterThan(0.5);
  });

  test("looking around does not read as a blink", () => {
    const flow = new CalibrationFlow();
    flow.restart();

    const looking = { blinkLeft: 0.45, blinkRight: 0.45, lidLeft: 0.22, lidRight: 0.22 };
    holdStep(flow); // neutral
    // All four corner holds are made with the eyes open, and the model's readings
    // drift while the gaze travels: none of that is a blink.
    holdStep(flow, looking); // lookTopLeft
    holdStep(flow, looking); // lookTopRight
    holdStep(flow, looking); // lookBottomRight
    holdStep(flow, looking); // lookBottomLeft
    holdStep(flow); // smile
    holdStep(flow); // sad
    holdStep(flow); // jaw
    const closed = { lidLeft: 0.02, lidRight: 0.02, blinkLeft: 0.62, blinkRight: 0.62 };
    holdStep(flow, closed); // closedLeft
    const calibration = holdStep(flow, closed)!; // closedRight

    const open = faceSample(reading(looking), calibration);
    expect(open.blinkLeft).toBe(0);
    expect(open.blinkRight).toBe(0);

    const shut = faceSample(reading(closed), calibration);
    expect(shut.blinkLeft).toBe(1);
    expect(shut.blinkRight).toBe(1);
  });

  test("a pose that never moved leaves a range too flat to use", () => {
    const flow = new CalibrationFlow();
    flow.restart();

    const calibration = runFlow(flow);

    // Nothing moved between the rest and shut poses, so the lid signal is
    // ignored instead of inventing a blink.
    expect(calibration.shut.lidLeft).toBe(calibration.neutral.lidLeft);
    expect(ratio(0.4, calibration.neutral.lidLeft, calibration.shut.lidLeft, 0.03)).toBe(0);
  });

  test("cancelling drops what has been measured", () => {
    const flow = new CalibrationFlow();
    flow.restart();
    holdStep(flow);

    flow.cancel();
    expect(flow.running).toBe(false);
    expect(flow.progress.step).toBeNull();
  });

  test("restarts from the first pose, waiting for Start", () => {
    const flow = new CalibrationFlow();
    flow.restart();
    holdStep(flow);

    flow.restart();
    expect(flow.progress.step).toBe("neutral");
    expect(flow.progress.index).toBe(1);
    expect(flow.progress.armed).toBe(false);
    expect(flow.progress.total).toBe(CALIBRATION_STEPS.length);
  });
});
