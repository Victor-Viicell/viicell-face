import { describe, expect, test } from "bun:test";
import {
  CALIBRATION_STEPS,
  CalibrationFlow,
  MAX_STEP_SAMPLES,
  MIN_FOLLOW_SAMPLES,
  MIN_STEP_SAMPLES,
  SETTLE_SAMPLES,
  medianSample,
  traceCoverage,
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
  lookH: 0,
  lookV: 0,
  smileLeft: 0.1,
  smileRight: 0.1,
  frownLeft: 0,
  frownRight: 0,
  jawOpen: 0,
  cheekSquintLeft: 0,
  cheekSquintRight: 0,
  browDownLeft: 0.05,
  browDownRight: 0.05,
};

const reading = (fields: Partial<RawSample> = {}): RawSample => ({ ...BASE, ...fields });

const CURSOR_MIDDLE = { u: 0.5, v: 0.5 };

/**
 * Holds the current step, then presses Next.
 *
 * The cursor follow is fed a sweep of paired readings — the face looking from
 * one edge to the other while the pointer does the same — the way a person
 * following the pointer produces them. Every other step is a still pose.
 */
function holdStep(flow: CalibrationFlow, pose: Partial<RawSample> = {}): Calibration | null {
  flow.start();
  for (let index = 0; index < SETTLE_SAMPLES; index += 1) {
    flow.add(reading(pose), CURSOR_MIDDLE);
  }

  if (flow.progress.step === "follow") {
    for (let index = 0; index < MIN_FOLLOW_SAMPLES; index += 1) {
      const t = index / (MIN_FOLLOW_SAMPLES - 1);
      // Positive lookH/lookV is a look towards the top left, so both fall as
      // the cursor travels towards the bottom right.
      flow.add(reading({ ...pose, lookH: 0.4 - 0.8 * t, lookV: 0.4 - 0.8 * t }), {
        u: 0.1 + 0.8 * t,
        v: 0.1 + 0.8 * t,
      });
    }
    return flow.next();
  }

  for (let index = 0; index < MIN_STEP_SAMPLES; index += 1) {
    flow.add(reading(pose), CURSOR_MIDDLE);
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

describe("traceCoverage", () => {
  test("is zero without a trace", () => {
    expect(traceCoverage([])).toBe(0);
  });

  test("needs the cursor out in every direction", () => {
    // A sweep across the middle covers left/right but not top/bottom.
    const across = [
      { raw: reading(), u: 0.05, v: 0.5 },
      { raw: reading(), u: 0.95, v: 0.5 },
    ];
    expect(traceCoverage(across)).toBe(0);

    const everywhere = [
      { raw: reading(), u: 0.1, v: 0.1 },
      { raw: reading(), u: 0.9, v: 0.9 },
    ];
    expect(traceCoverage(everywhere)).toBe(1);
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
      flow.add(reading(), CURSOR_MIDDLE);
    }
    expect(flow.progress.samples).toBe(0);
    expect(flow.progress.settling).toBe(false);

    for (let index = 0; index < MIN_STEP_SAMPLES; index += 1) {
      flow.add(reading(), CURSOR_MIDDLE);
    }
    expect(flow.progress.ready).toBe(true);
    // The pose is only left when Next is pressed.
    expect(flow.progress.step).toBe("neutral");

    expect(flow.next()).toBeNull();
    expect(flow.progress.step).toBe("follow");
    expect(flow.progress.armed).toBe(false);
    expect(flow.progress.ready).toBe(false);
  });

  test("the follow waits for the cursor and for the whole screen", () => {
    const flow = new CalibrationFlow();
    flow.restart();
    holdStep(flow); // neutral

    flow.start();
    for (let index = 0; index < SETTLE_SAMPLES + MIN_FOLLOW_SAMPLES; index += 1) {
      // A reading without a cursor tells the fit nothing and is dropped.
      flow.add(reading());
    }
    expect(flow.progress.samples).toBe(0);

    // Following only across the middle is not enough either.
    for (let index = 0; index < MIN_FOLLOW_SAMPLES; index += 1) {
      flow.add(reading(), { u: 0.4 + 0.2 * (index % 2), v: 0.5 });
    }
    expect(flow.progress.samples).toBe(MIN_FOLLOW_SAMPLES);
    expect(flow.progress.ready).toBe(false);
    expect(flow.progress.hint).toBe("keep going, out to the edges");

    for (let index = 0; index < MIN_FOLLOW_SAMPLES; index += 1) {
      flow.add(reading(), { u: 0.1 + 0.8 * (index / (MIN_FOLLOW_SAMPLES - 1)), v: 0.1 });
      flow.add(reading(), { u: 0.9, v: 0.1 + 0.8 * (index / (MIN_FOLLOW_SAMPLES - 1)) });
    }
    expect(flow.progress.ready).toBe(true);
  });

  test("keeps only the first readings of a pose", () => {
    const flow = new CalibrationFlow();
    flow.restart();
    flow.start();

    for (let index = 0; index < MAX_STEP_SAMPLES * 2; index += 1) {
      flow.add(reading(), CURSOR_MIDDLE);
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
    holdStep(flow); // follow
    holdStep(flow, {
      smileLeft: 0.85,
      smileRight: 0.8,
      cheekSquintLeft: 0.6,
      cheekSquintRight: 0.55,
    });
    holdStep(flow, { browDownLeft: 0.7, browDownRight: 0.75, frownLeft: 0.4, frownRight: 0.45 });
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
    expect(calibration!.jawMax).toBeCloseTo(0.72);
    // The trace is taken with the eyes open, so it is the reference for "open".
    expect(calibration!.open.scoreLeft).toBeCloseTo(0.2);
    expect(calibration!.open.lidLeft).toBeCloseTo(0.28);
    expect(calibration!.gaze).not.toBeNull();
    expect(flow.progress.step).toBeNull();
    expect(flow.running).toBe(false);
  });

  test("fits the gaze to the cursor follow", () => {
    const flow = new CalibrationFlow();
    flow.restart();
    const calibration = runFlow(flow);

    // The sweep looks towards the top left for u,v 0.1 and the bottom right
    // for u,v 0.9, so the fitted look has to point the same way.
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

    holdStep(flow); // neutral
    // The trace is held with the eyes open, and the model's readings drift
    // while the gaze travels: none of that is a blink.
    holdStep(flow, { blinkLeft: 0.45, blinkRight: 0.45, lidLeft: 0.22, lidRight: 0.22 });
    holdStep(flow);
    holdStep(flow);
    holdStep(flow);
    const closed = { lidLeft: 0.02, lidRight: 0.02, blinkLeft: 0.62, blinkRight: 0.62 };
    holdStep(flow, closed);
    const calibration = holdStep(flow, closed)!;

    const open = faceSample(
      reading({ blinkLeft: 0.45, blinkRight: 0.45, lidLeft: 0.22, lidRight: 0.22 }),
      calibration,
    );
    expect(open.blinkLeft).toBe(0);
    expect(open.blinkRight).toBe(0);

    const shut = faceSample(
      reading({ blinkLeft: 0.62, blinkRight: 0.62, lidLeft: 0.02, lidRight: 0.02 }),
      calibration,
    );
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
