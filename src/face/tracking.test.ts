import { describe, expect, test } from "bun:test";
import { ANCHOR_POINTS } from "../anchor";
import { MOUTH } from "./art";
import type { FaceRig } from "./rig";
import type { FaceSample } from "./tracker";
import {
  BLINK_HOLD,
  FaceTracking,
  PoseFilter,
  blinkState,
  deadZone,
  stepBlink,
  type BlinkState,
} from "./tracking";

const DT = 1 / 30;

function frames(state: BlinkState, target: number, count: number): void {
  for (let i = 0; i < count; i++) {
    stepBlink(state, target, DT);
  }
}

describe("stepBlink", () => {
  test("takes a real blink all the way shut", () => {
    const lid = blinkState();
    frames(lid, 0.85, 12);
    expect(lid.value).toBeGreaterThan(0.95);
  });

  test("leaves a slow squint where the reading put it", () => {
    const lid = blinkState();
    frames(lid, 0.4, 30);
    expect(lid.value).toBeLessThan(0.45);
  });

  test("stays shut while the reading starts to open", () => {
    const lid = blinkState();
    frames(lid, 0.9, 12);
    const shut = lid.value;

    // The reading has dropped, but the lid is held for the blink's duration.
    const holdFrames = Math.floor(BLINK_HOLD / DT) - 1;
    frames(lid, 0, holdFrames);
    expect(lid.value).toBe(shut);
  });

  test("then opens more slowly than it shut", () => {
    const lid = blinkState();
    frames(lid, 0.9, 12);

    // Past the hold, and still most of the way closed.
    frames(lid, 0, Math.ceil(BLINK_HOLD / DT) + 3);
    expect(lid.value).toBeGreaterThan(0.4);
    expect(lid.value).toBeLessThan(1);

    frames(lid, 0, 60);
    expect(lid.value).toBeLessThan(0.05);
  });

  test("holds again on the next blink", () => {
    const lid = blinkState();
    frames(lid, 0.9, 12);
    frames(lid, 0, 90);
    const open = lid.value;

    frames(lid, 0.9, 12);
    expect(lid.value).toBeGreaterThan(0.95);

    frames(lid, 0, 1);
    expect(lid.value).toBeGreaterThan(0.95);

    // Sanity: it really had opened before the second blink.
    expect(open).toBeLessThan(0.05);
  });
});

describe("deadZone", () => {
  test("swallows readings below the width", () => {
    expect(deadZone(0.02, 0.035)).toBe(0);
    expect(deadZone(-0.02, 0.035)).toBe(0);
  });

  test("keeps the direction and still reaches full scale", () => {
    expect(deadZone(1, 0.1)).toBeCloseTo(1, 6);
    expect(deadZone(-1, 0.1)).toBeCloseTo(-1, 6);
    expect(deadZone(0.55, 0.1)).toBeCloseTo(0.5, 6);
  });
});

describe("PoseFilter", () => {
  const options = { minCutoff: 0.9, beta: 1.8, derivativeCutoff: 1 };

  test("follows a real movement within a few frames", () => {
    const filter = new PoseFilter(options);
    filter.reset(0);

    let value = 0;
    for (let i = 0; i < 5; i++) {
      value = filter.filter(0.8, DT);
    }
    expect(value).toBeGreaterThan(0.7);
  });

  test("soaks up noise while the reading is still", () => {
    const filter = new PoseFilter(options);
    filter.reset(0.5);

    let low = 1;
    let high = 0;
    for (let i = 0; i < 120; i++) {
      // One pixel of landmark wobble, in rig units.
      const value = filter.filter(0.5 + (i % 2 === 0 ? 0.01 : -0.01), DT);
      low = Math.min(low, value);
      high = Math.max(high, value);
    }
    expect(high - low).toBeLessThan(0.01);
  });

  test("starts from the first reading instead of easing up to it", () => {
    const filter = new PoseFilter(options);
    expect(filter.filter(0.4, DT)).toBe(0.4);
  });
});

/** Records the values written to the rig, in call order. */
function fakeRig() {
  const log: Record<string, number> = {};
  const rig = {
    setHead: (x: number, y: number, yaw = 0, pitch = 0) => {
      log.headX = x;
      log.headY = y;
      log.headYaw = yaw;
      log.headPitch = pitch;
    },
    setTrackedLook: (x: number, y: number) => {
      log.lookX = x;
      log.lookY = y;
    },
    setEyeClose: () => {},
    setEyeWide: (value: number) => {
      log.eyeWide = value;
    },
    setBrowClose: (value: number) => {
      log.brow = Math.max(log.brow ?? 0, value);
    },
    setCheekClose: () => {},
    setCheekLift: () => {},
    setMouthOpen: (value: number) => {
      log.mouthOpen = value;
    },
    setMouthWidth: (value: number) => {
      log.mouthWidth = value;
    },
    setMouthBottomWidth: (value: number) => {
      log.mouthBottomWidth = value;
    },
    setMouthCorner: (side: "left" | "right", value: number) => {
      log[side === "left" ? "cornerLeft" : "cornerRight"] = value;
    },
    setMouthPose: (x: number, y: number, tilt: number) => {
      log.mouthShiftX = x;
      log.mouthShiftY = y;
      log.mouthTilt = tilt;
    },
    resetMouth: () => {},
  } as unknown as FaceRig;
  return { log, rig };
}

function sample(overrides: Partial<FaceSample> = {}): FaceSample {
  return {
    x: 0,
    y: 0,
    headYaw: 0,
    headPitch: 0,
    blinkLeft: 0,
    blinkRight: 0,
    eyeWide: 0,
    eyeWideScore: 0,
    lookX: 0,
    lookY: 0,
    cheekLeft: 0,
    cheekRight: 0,
    browLeft: 0,
    browRight: 0,
    mouthOpen: 0,
    mouthWidth: 0,
    mouthPucker: 0,
    mouthShiftX: 0,
    mouthShiftY: 0,
    mouthTilt: 0,
    mouthBottomWidth: 0,
    mouthHappyLeft: 0,
    mouthHappyRight: 0,
    mouthSadLeft: 0,
    mouthSadRight: 0,
    ...overrides,
  };
}

describe("FaceTracking", () => {
  test("holds the face still through landmark noise", () => {
    const tracking = new FaceTracking();
    const { log, rig } = fakeRig();

    for (let i = 0; i < 90; i++) {
      const wobble = i % 2 === 0 ? 0.02 : -0.02;
      tracking.set(sample({ x: wobble, y: wobble, lookX: wobble * 0.7, lookY: wobble }));
      tracking.update(rig, DT);
    }

    expect(Math.abs(log.headX)).toBeLessThan(0.001);
    expect(Math.abs(log.lookX)).toBeLessThan(0.001);
    expect(Math.abs(log.lookY)).toBeLessThan(0.001);
  });

  test("still follows a deliberate look", () => {
    const tracking = new FaceTracking();
    const { log, rig } = fakeRig();

    tracking.set(sample());
    tracking.update(rig, DT);

    tracking.set(sample({ lookX: 0.6, lookY: 0.4 }));
    for (let i = 0; i < 10; i++) {
      tracking.update(rig, DT);
    }

    expect(log.lookX).toBeGreaterThan(0.45);
    expect(log.lookY).toBeGreaterThan(0.25);
  });

  test("moves the eyes with the head turn, apart from the gaze", () => {
    const tracking = new FaceTracking();
    const { log, rig } = fakeRig();

    tracking.set(sample({ headYaw: 1, headPitch: -1, lookX: 0, lookY: 0 }));
    for (let i = 0; i < 30; i++) {
      tracking.update(rig, DT);
    }

    expect(log.headYaw).toBeGreaterThan(0.9);
    expect(log.headPitch).toBeLessThan(-0.9);
    // The head turn is its own channel: the gaze itself did not move.
    expect(log.lookX).toBeCloseTo(0, 5);
    expect(log.lookY).toBeCloseTo(0, 5);
  });

  test("shrinks the eyes when they bulge, and lets go at rest", () => {
    const tracking = new FaceTracking();
    const { log, rig } = fakeRig();

    tracking.set(sample({ eyeWide: 1 }));
    for (let i = 0; i < 30; i++) {
      tracking.update(rig, DT);
    }
    expect(log.eyeWide).toBeGreaterThan(0.9);

    tracking.set(sample({ eyeWide: 0 }));
    for (let i = 0; i < 60; i++) {
      tracking.update(rig, DT);
    }
    expect(log.eyeWide).toBeLessThan(0.05);
  });

  test("holds the gaze and the eye lean while the eyes bulge", () => {
    const tracking = new FaceTracking();
    const { log, rig } = fakeRig();

    tracking.set(sample({ lookX: 0.6, headYaw: 0.6 }));
    for (let i = 0; i < 20; i++) {
      tracking.update(rig, DT);
    }
    const heldLook = log.lookX;
    const heldYaw = log.headYaw;

    // The bulge drags the landmark-based readings the other way; the gaze and
    // head lean must hold the pre-bulge direction, while the eye size still answers.
    tracking.set(sample({ lookX: -0.6, headYaw: -0.6, eyeWide: 1, eyeWideScore: 1 }));
    for (let i = 0; i < 20; i++) {
      tracking.update(rig, DT);
    }
    expect(log.lookX).toBeCloseTo(heldLook, 2);
    expect(log.headYaw).toBeCloseTo(heldYaw, 2);
    expect(log.eyeWide).toBeGreaterThan(0.5);

    // Released: the gaze follows the live reading again.
    tracking.set(sample({ lookX: -0.6, headYaw: -0.6 }));
    for (let i = 0; i < 40; i++) {
      tracking.update(rig, DT);
    }
    expect(log.lookX).toBeLessThan(0);
  });

  test("opens, widens and lifts the mouth from the tracked signals", () => {
    const tracking = new FaceTracking();
    const { log, rig } = fakeRig();

    tracking.set(
      sample({
        mouthOpen: 1,
        mouthWidth: 1,
        mouthBottomWidth: 1,
        mouthHappyLeft: 1,
        mouthHappyRight: 0.8,
        mouthSadLeft: 0,
        mouthSadRight: 0,
      }),
    );
    for (let i = 0; i < 30; i++) {
      tracking.update(rig, DT);
    }

    expect(log.mouthOpen).toBeGreaterThan(0.95);
    expect(log.mouthWidth).toBeGreaterThan(0.95);
    expect(log.mouthBottomWidth).toBeGreaterThan(0.95);
    expect(log.cornerLeft).toBeGreaterThan(0.9);
    // A weaker smile on the right leaves that corner a little less upturned.
    expect(log.cornerRight).toBeGreaterThan(0.5);
    expect(log.cornerRight).toBeLessThan(log.cornerLeft);
  });

  test("cuts the corners down with a frown", () => {
    const tracking = new FaceTracking();
    const { log, rig } = fakeRig();

    tracking.set(sample({ mouthHappyLeft: 0, mouthHappyRight: 0, mouthSadLeft: 1, mouthSadRight: 0.5 }));
    for (let i = 0; i < 30; i++) {
      tracking.update(rig, DT);
    }

    // The left corner reaches the full sad cut, the right one follows it down.
    expect(log.cornerLeft).toBeLessThan(-0.9);
    expect(log.cornerRight).toBeLessThan(0);
    expect(log.cornerRight).toBeGreaterThan(log.cornerLeft);
  });

  test("narrows the mouth with rounded lips", () => {
    const tracking = new FaceTracking();
    const { log, rig } = fakeRig();

    tracking.set(sample({ mouthPucker: 1 }));
    for (let i = 0; i < 30; i++) {
      tracking.update(rig, DT);
    }

    // An "o"/"u" shape narrows the mouth without a frown at either corner.
    expect(log.mouthWidth).toBeLessThan(0.1);
    expect(log.cornerLeft).toBeCloseTo(MOUTH.rest.corner, 5);
  });

  test("narrows the mouth with a frown", () => {
    const tracking = new FaceTracking();
    const { log, rig } = fakeRig();

    tracking.set(sample({ mouthWidth: 0, mouthSadLeft: 1, mouthSadRight: 1 }));
    for (let i = 0; i < 30; i++) {
      tracking.update(rig, DT);
    }

    // A frown travels from the rest width down to the narrow reference.
    expect(log.mouthWidth).toBeLessThan(0.05);
  });

  test("moves and twists the whole mouth from the tracked signals", () => {
    const tracking = new FaceTracking();
    const { log, rig } = fakeRig();

    tracking.set(sample({ mouthShiftX: 1, mouthShiftY: 0.5, mouthTilt: -1 }));
    for (let i = 0; i < 30; i++) {
      tracking.update(rig, DT);
    }

    expect(log.mouthShiftX).toBeGreaterThan(0.9);
    expect(log.mouthShiftY).toBeGreaterThan(0.4);
    expect(log.mouthTilt).toBeLessThan(-0.9);
  });

  test("holds a still mouth in place through landmark noise", () => {
    const tracking = new FaceTracking();
    const { log, rig } = fakeRig();

    for (let i = 0; i < 90; i++) {
      const wobble = i % 2 === 0 ? 0.03 : -0.03;
      tracking.set(sample({ mouthShiftX: wobble, mouthShiftY: wobble, mouthTilt: wobble }));
      tracking.update(rig, DT);
    }

    expect(Math.abs(log.mouthShiftX)).toBeLessThan(0.001);
    expect(Math.abs(log.mouthShiftY)).toBeLessThan(0.001);
    expect(Math.abs(log.mouthTilt)).toBeLessThan(0.001);
  });

  test("leaves a relaxed mouth at the artwork's rest pose", () => {
    const tracking = new FaceTracking();
    const { log, rig } = fakeRig();

    tracking.set(sample());
    for (let i = 0; i < 5; i++) {
      tracking.update(rig, DT);
    }

    expect(log.mouthOpen).toBeCloseTo(MOUTH.rest.open, 5);
    expect(log.mouthWidth).toBeCloseTo(MOUTH.rest.width, 5);
    expect(log.mouthBottomWidth).toBeCloseTo(MOUTH.rest.bottomWidth, 5);
    expect(log.cornerLeft).toBeCloseTo(MOUTH.rest.corner, 5);
    expect(log.cornerRight).toBeCloseTo(MOUTH.rest.corner, 5);
  });

  test("stops a frown halfway across the eye", () => {
    const tracking = new FaceTracking();
    const { log, rig } = fakeRig();

    tracking.set(sample({ browLeft: 1, browRight: 1 }));
    for (let i = 0; i < 60; i++) {
      tracking.update(rig, DT);
    }

    expect(log.brow).toBeGreaterThan(0.4);
    expect(log.brow).toBeLessThanOrEqual(0.5);
  });

  test("aims the tracked gaze from the chosen corner", () => {
    const tracking = new FaceTracking();
    const { log, rig } = fakeRig();

    // The person looks at the middle of the screen; from the top left corner
    // that has to read as down and to the right.
    tracking.set(sample());
    for (let i = 0; i < 10; i++) {
      tracking.update(rig, DT, ANCHOR_POINTS.topLeft);
    }

    expect(log.lookX).toBeCloseTo(0.5, 5);
    expect(log.lookY).toBeCloseTo(0.5, 5);
  });
});
