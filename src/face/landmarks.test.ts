import { describe, expect, test } from "bun:test";
import {
  NO_CALIBRATION,
  closure,
  discountFrown,
  faceSample,
  fitGaze,
  gazePoint,
  medianOf,
  percentileOf,
  ratio,
  readFace,
  type Calibration,
  type Landmark,
  type RawSample,
  type Shape,
} from "./landmarks";

interface FaceOptions {
  /** Nose offset from the face centre, in frame units. */
  noseDx?: number;
  noseDy?: number;
  /** Lid gap, in frame units. */
  lidGap?: number;
  /** Blendshape scores, already in viewer's-left/right terms. */
  blinkLeft?: number;
  blinkRight?: number;
}

/**
 * A frontal synthetic face. Eye corners at y 0.40, face edges at 0.16/0.84, nose
 * 0.05 below the eye line, lids 0.02 apart.
 */
function face(options: FaceOptions = {}): Landmark[] {
  const marks: Landmark[] = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
  const gap = options.lidGap ?? 0.02;

  // Viewer's left eye (subject's right).
  marks[33] = { x: 0.3, y: 0.4 };
  marks[133] = { x: 0.42, y: 0.4 };
  marks[159] = { x: 0.36, y: 0.4 - gap / 2 };
  marks[145] = { x: 0.36, y: 0.4 + gap / 2 };

  // Viewer's right eye (subject's left).
  marks[362] = { x: 0.58, y: 0.4 };
  marks[263] = { x: 0.7, y: 0.4 };
  marks[386] = { x: 0.64, y: 0.4 - gap / 2 };
  marks[374] = { x: 0.64, y: 0.4 + gap / 2 };

  marks[234] = { x: 0.16, y: 0.5 };
  marks[454] = { x: 0.84, y: 0.5 };
  marks[1] = { x: 0.5 + (options.noseDx ?? 0), y: 0.45 + (options.noseDy ?? 0) };
  return marks;
}

const shapes = (scores: Record<string, number>): Shape[] =>
  Object.entries(scores).map(([categoryName, score]) => ({ categoryName, score }));

const read = (options: FaceOptions = {}, scores: Record<string, number> = {}): RawSample =>
  readFace(face(options), shapes(scores))!;

/** A calibration resting on `rest`, with a range these tests can reason about. */
const calibratedWith = (rest: RawSample, overrides: Partial<Calibration> = {}): Calibration => ({
  neutral: { ...rest, calibrated: true },
  shut: { scoreLeft: 0.8, lidLeft: 0.01, scoreRight: 0.8, lidRight: 0.01 },
  open: { scoreLeft: 0, lidLeft: 1, scoreRight: 0, lidRight: 1 },
  // The weights the old fixed gains gave, so the direction tests keep meaning.
  gaze: {
    x: { head: -2.75, eye: -1.1 },
    y: { head: 2, eye: -1.4 },
  },
  cheek: { smileLeft: 1, smileRight: 1, squintLeft: 1, squintRight: 1 },
  jawMax: 1,
  browMaxLeft: 1,
  browMaxRight: 1,
  frownMaxLeft: 1,
  frownMaxRight: 1,
  ...overrides,
});

describe("readFace", () => {
  test("measures head position from the eye corners", () => {
    const raw = read();
    expect(raw.x).toBeCloseTo(0.5);
    expect(raw.y).toBeCloseTo(0.4);
  });

  test("has no reading without the eye corners", () => {
    expect(readFace([], [])).toBeNull();
  });

  test("reads a head turn from the nose, positive to the viewer's right", () => {
    const centred = read().yaw;
    expect(read({ noseDx: 0.05 }).yaw).toBeGreaterThan(centred);
    expect(read({ noseDx: -0.05 }).yaw).toBeLessThan(centred);
    expect(read({ noseDx: 0.05 }).yaw - centred).toBeCloseTo(0.05 / 0.34);
  });

  test("reads a nod from the nose dropping in the frame", () => {
    const level = read().pitch;
    expect(read({ noseDy: 0.05 }).pitch).toBeGreaterThan(level);
    expect(read({ noseDy: -0.05 }).pitch).toBeLessThan(level);
  });

  test("measures each lid gap, and closes it", () => {
    const open = read();
    expect(open.lidLeft).toBeGreaterThan(0.05);
    expect(open.lidLeft).toBeCloseTo(open.lidRight);
    expect(read({ lidGap: 0 }).lidLeft).toBe(0);
  });

  test("maps MediaPipe's subject-left blink to the viewer's right", () => {
    const raw = read({}, { eyeBlinkLeft: 0.9, eyeBlinkRight: 0.1 });
    expect(raw.blinkRight).toBeCloseTo(0.9);
    expect(raw.blinkLeft).toBeCloseTo(0.1);
  });

  test("turns towards the viewer's right when the left eye looks out", () => {
    // The subject's left eye is on the viewer's right, so "out left" and
    // "in right" are the same direction.
    expect(read({}, { eyeLookOutLeft: 0.6, eyeLookInRight: 0.6 }).lookH).toBeCloseTo(0.6);
  });

  test("turns towards the viewer's left when the right eye looks out", () => {
    expect(read({}, { eyeLookInLeft: 0.5, eyeLookOutRight: 0.5 }).lookH).toBeCloseTo(-0.5);
  });

  test("reports an upward look as positive", () => {
    expect(read({}, { eyeLookUpLeft: 0.4, eyeLookUpRight: 0.4 }).lookV).toBeCloseTo(0.4);
  });

  test("reads each mouth corner, and the cheek beside it", () => {
    const raw = read({}, { mouthSmileLeft: 0.6, mouthSmileRight: 0.4 });
    // The subject's left corner is on the viewer's right.
    expect(raw.smileRight).toBeCloseTo(0.6);
    expect(raw.smileLeft).toBeCloseTo(0.4);
  });

  test("maps the subject's cheek raise to the viewer's other side", () => {
    const raw = read({}, { cheekSquintLeft: 0.7, cheekSquintRight: 0.2 });
    expect(raw.cheekSquintRight).toBeCloseTo(0.7);
    expect(raw.cheekSquintLeft).toBeCloseTo(0.2);
  });

  test("reads the jaw and each mouth frown, mirrored like the smile", () => {
    const raw = read({}, { jawOpen: 0.6, mouthFrownLeft: 0.7, mouthFrownRight: 0.2 });
    expect(raw.jawOpen).toBeCloseTo(0.6, 5);
    expect(raw.frownLeft).toBeCloseTo(0.2, 5);
    expect(raw.frownRight).toBeCloseTo(0.7, 5);
  });

  test("maps the subject's brow to the viewer's other side", () => {
    const raw = read({}, { browDownLeft: 0.8, browDownRight: 0.1 });
    expect(raw.browDownRight).toBeCloseTo(0.8);
    expect(raw.browDownLeft).toBeCloseTo(0.1);
  });
});

describe("faceSample", () => {
  test("subtracts the neutral head position", () => {
    const rest = read();
    const moved = readFace(face({ noseDx: 0 }), [])!;
    const sample = faceSample(moved, calibratedWith({ ...rest, x: 0.45, y: 0.35 }));
    // Negated: the rig leans towards the screen side the head moved to.
    expect(sample.x).toBeCloseTo(-0.13);
    expect(sample.y).toBeCloseTo(0.13);
  });

  test("adds the head turn to the gaze, so looking with the head works", () => {
    const rest = read();
    const turned = read({ noseDx: 0.05 });
    const sample = faceSample(turned, calibratedWith(rest));
    // The nose moving to the image's right means the head turned to the
    // person's left, and the face looks to the left of the screen.
    expect(sample.lookX).toBeLessThan(-0.5);
    expect(sample.lookX).toBeGreaterThanOrEqual(-1);
  });

  test("counts a dropped chin as looking down", () => {
    const rest = read();
    const nodded = read({ noseDy: 0.05 });
    expect(faceSample(nodded, calibratedWith(rest)).lookY).toBeGreaterThan(0.3);
  });

  test("still tracks the eyes in their sockets", () => {
    const rest = read();
    // The subject's left eye looks out: the person looks to their left, which
    // is the left of the screen.
    const glanced = read({}, { eyeLookOutLeft: 0.6, eyeLookInRight: 0.6 });
    expect(faceSample(glanced, calibratedWith(rest)).lookX).toBe(-1);
  });

  test("counts an upward look as negative y, because the rig points down", () => {
    const rest = read();
    const glanced = read({}, { eyeLookUpLeft: 0.4, eyeLookUpRight: 0.4 });
    expect(faceSample(glanced, calibratedWith(rest)).lookY).toBeLessThan(-0.5);
  });

  test("subtracts the neutral expressions", () => {
    const rest = read({}, { mouthSmileLeft: 0.1, mouthSmileRight: 0.1 });
    const smiling = read({}, { mouthSmileLeft: 0.8, mouthSmileRight: 0.8 });
    const sample = faceSample(smiling, calibratedWith(rest));
    expect(sample.cheekLeft).toBeGreaterThan(0.6);
    expect(sample.cheekRight).toBeGreaterThan(0.6);
  });

  test("moves a cheek from the cheek itself, without the mouth", () => {
    const rest = read();
    const grinning = read({}, { cheekSquintLeft: 0.9, cheekSquintRight: 0.9 });
    const sample = faceSample(grinning, calibratedWith(rest));

    expect(sample.cheekLeft).toBeGreaterThan(0.5);
    expect(sample.cheekRight).toBeGreaterThan(0.5);
  });

  test("moves only the cheek whose side rose", () => {
    const rest = read();
    // The subject's right cheek is on the viewer's left.
    const oneSided = read({}, { cheekSquintRight: 0.9 });
    const sample = faceSample(oneSided, calibratedWith(rest));

    expect(sample.cheekLeft).toBeGreaterThan(0.5);
    expect(sample.cheekRight).toBe(0);
  });

  test("drops only the brow that moved", () => {
    const rest = read();
    const frown = read({}, { browDownLeft: 0.9 });
    const sample = faceSample(frown, calibratedWith(rest));
    // Subject's left is the viewer's right.
    expect(sample.browRight).toBeGreaterThan(0.6);
    expect(sample.browLeft).toBe(0);
  });

  test("does not read a frown as a half-closed eye", () => {
    const rest = read({ lidGap: 0.02 }, { browDownLeft: 0.1, browDownRight: 0.1 });
    const calibration = calibratedWith(rest);

    // A hard frown squeezes the lid gap and nudges the blink score a little.
    const frown = read(
      { lidGap: 0.015 },
      { browDownLeft: 0.9, browDownRight: 0.9, eyeBlinkLeft: 0.15, eyeBlinkRight: 0.15 },
    );
    const sample = faceSample(frown, calibration);

    expect(sample.browLeft).toBeGreaterThan(0.7);
    expect(sample.browRight).toBeGreaterThan(0.7);
    expect(sample.blinkLeft).toBe(0);
    expect(sample.blinkRight).toBe(0);
  });

  test("still shuts the eye on a blink made while frowning", () => {
    const rest = read({ lidGap: 0.02 }, { browDownLeft: 0.1, browDownRight: 0.1 });
    const calibration = calibratedWith(rest);
    const shut = read(
      { lidGap: 0 },
      { browDownLeft: 0.9, browDownRight: 0.9, eyeBlinkLeft: 0.85, eyeBlinkRight: 0.85 },
    );
    const sample = faceSample(shut, calibration);

    expect(sample.blinkLeft).toBe(1);
    expect(sample.blinkRight).toBe(1);
  });

  test("widens the mouth with the smile and opens it with the jaw", () => {
    const rest = read();
    const raw = read(
      {},
      {
        jawOpen: 0.5,
        mouthSmileLeft: 0.8,
        mouthSmileRight: 0.8,
        mouthFrownLeft: 0.9,
        mouthFrownRight: 0.9,
      },
    );

    const sample = faceSample(raw, calibratedWith(rest));
    // The measured wide-open pose (jawMax 1 here) maps directly, with a gain so
    // an ordinary jaw reaches further than the calibration extreme would allow.
    expect(sample.mouthOpen).toBeCloseTo(0.75, 3);
    expect(sample.mouthWidth).toBeCloseTo(0.783, 3);
    expect(sample.mouthBottomWidth).toBeCloseTo(0.783, 3);
    expect(sample.mouthHappyLeft).toBeCloseTo(0.783, 3);
    expect(sample.mouthHappyRight).toBeCloseTo(0.783, 3);
    // A smile wins over a frown reported at the same time.
    expect(sample.mouthSadLeft).toBeCloseTo(0.109, 3);
    expect(sample.mouthSadRight).toBeCloseTo(0.109, 3);
  });

  test("moves each mouth corner on its own", () => {
    const rest = read();
    const oneSided = read({}, { mouthSmileLeft: 0.8 });
    const sample = faceSample(oneSided, calibratedWith(rest));

    // The subject's left corner is on the viewer's right.
    expect(sample.mouthHappyRight).toBeGreaterThan(0.7);
    expect(sample.mouthHappyLeft).toBe(0);
    expect(sample.mouthSadRight).toBe(0);
    expect(sample.mouthSadLeft).toBe(0);
  });

  test("opens on the first small jaw movement", () => {
    // A jaw score of 0.05 must not be swallowed by a range dead zone: the mouth
    // should answer it on the same frame.
    const rest = read({}, { jawOpen: 0.01 });
    const sample = faceSample(read({}, { jawOpen: 0.05 }), calibratedWith(rest, { jawMax: 0.6 }));
    expect(sample.mouthOpen).toBeGreaterThan(0.1);
  });

  test("keeps the mouth signals at rest before calibrating", () => {
    const sample = faceSample(read({}, { jawOpen: 0.4 }), NO_CALIBRATION);
    expect(sample.mouthOpen).toBeCloseTo(0.6, 5);
    expect(sample.mouthWidth).toBeCloseTo(0, 5);
    expect(sample.mouthBottomWidth).toBeCloseTo(0.6, 5);
    expect(sample.mouthHappyLeft).toBeCloseTo(0, 5);
    expect(sample.mouthHappyRight).toBeCloseTo(0, 5);
    expect(sample.mouthSadLeft).toBeCloseTo(0, 5);
    expect(sample.mouthSadRight).toBeCloseTo(0, 5);
  });

  test("still moves the mouth before the calibration is measured", () => {
    // A mouth channel stuck at zero reads as a broken rig; the fallback span is
    // what lets a smile and a frown show up on the very first tracked frame.
    const sample = faceSample(
      read({}, { mouthSmileLeft: 0.8, mouthSmileRight: 0.8 }),
      NO_CALIBRATION,
    );
    expect(sample.mouthWidth).toBeGreaterThan(0.7);
    expect(sample.mouthHappyLeft).toBeGreaterThan(0.7);
  });

  test("falls back on a usable span when the measured frown is flat", () => {
    const rest = read();
    const calibration = calibratedWith(rest, { frownMaxLeft: 0, frownMaxRight: 0 });
    // The subject's right frown is the viewer's left corner.
    const sample = faceSample(read({}, { mouthFrownRight: 0.4 }), calibration);

    // 0.4 out of the 0.5 fallback span, so the corner still reaches the cut.
    expect(sample.mouthSadLeft).toBeGreaterThan(0.7);
    expect(sample.mouthSadRight).toBe(0);
  });

  test("holds the pose at rest until the calibration is measured", () => {
    const raw = read({ noseDx: 0.1, noseDy: 0.1 });
    const sample = faceSample(raw, NO_CALIBRATION);
    expect(sample.x).toBe(0);
    expect(sample.y).toBe(0);
    expect(sample.lookX).toBe(0);
    expect(sample.lookY).toBe(0);
    expect(sample.blinkLeft).toBe(0);
  });
});

describe("ratio", () => {
  test("maps the two measured poses to 0 and 1", () => {
    expect(ratio(0.25, 0.25, 0.01, 0.03)).toBe(0);
    expect(ratio(0.01, 0.25, 0.01, 0.03)).toBe(1);
  });

  test("ignores a range too flat to read", () => {
    expect(ratio(0.3, 0.3, 0.31, 0.08)).toBe(0);
  });

  test("keeps a relaxed face at zero", () => {
    // Just inside the deadzone of the measured range still reads as nothing.
    expect(ratio(0.24, 0.25, 0.01, 0.03)).toBe(0);
  });

  test("a score that plateaus still closes the eye", () => {
    // On this face the score only rises from 0.30 at rest to 0.65 shut.
    expect(ratio(0.65, 0.3, 0.65, 0.08)).toBe(1);
  });
});

describe("closure", () => {
  test("takes the stronger of the two measures", () => {
    expect(closure(0.9, 0, 0)).toBeCloseTo(0.9);
    expect(closure(0, 0.8, 0)).toBeCloseTo(0.8);
  });

  test("reaches one when either measure is complete", () => {
    expect(closure(1, 0, 0)).toBe(1);
    // A low score is common on a real blink; the shut lids have to carry it.
    expect(closure(0.1, 1, 0)).toBe(1);
  });

  test("ignores a wink's cross-talk on the open eye", () => {
    // MediaPipe lifts both scores during a wink: the eye that trails the other
    // must not follow, and an open lid closes nothing.
    expect(closure(0.45, 0, 1)).toBe(0);
    // Two eyes blinking together stay within the margin.
    expect(closure(0.85, 0, 1)).toBeCloseTo(0.85);
  });
});

describe("discountFrown", () => {
  test("takes a share of the brow movement back off a frown", () => {
    expect(discountFrown(0.5, 1, 0.45)).toBeCloseTo(0.275, 6);
  });

  test("cannot loosen a lid that is already shut", () => {
    expect(discountFrown(1, 1, 0.45)).toBe(1);
  });
});

describe("fitGaze", () => {
  const neutral = read();

  test("learns the eye weight from a cursor sweep", () => {
    // Positive lookH is a look to the left of the screen.
    const left = read({}, { eyeLookOutLeft: 0.4, eyeLookInRight: 0.4 });
    const right = read({}, { eyeLookInLeft: 0.4, eyeLookOutRight: 0.4 });
    const fit = fitGaze(
      [
        { raw: left, u: 0.1, v: 0.5 },
        { raw: right, u: 0.9, v: 0.5 },
      ],
      neutral,
    )!;

    expect(fit.x.eye).toBeCloseTo(-1, 2);
    expect(fit.x.head).toBeCloseTo(0, 6);
    expect(gazePoint(left, neutral, fit).u).toBeCloseTo(0.1, 2);
    expect(gazePoint(right, neutral, fit).u).toBeCloseTo(0.9, 2);
  });

  test("learns the head weight when only the head turns", () => {
    const left = read({ noseDx: 0.1 });
    const right = read({ noseDx: -0.1 });
    const fit = fitGaze(
      [
        { raw: left, u: 0.1, v: 0.5 },
        { raw: right, u: 0.9, v: 0.5 },
      ],
      neutral,
    )!;

    expect(fit.x.head).toBeLessThan(-1);
    expect(fit.x.eye).toBeCloseTo(0, 6);
    expect(gazePoint(left, neutral, fit).u).toBeCloseTo(0.1, 2);
  });

  test("needs a trace to fit", () => {
    expect(fitGaze([], neutral)).toBeNull();
  });
});

describe("percentileOf", () => {
  test("reads the requested quantile", () => {
    const values = [10, 1, 9, 2, 8, 3, 7, 4, 6, 5];
    expect(percentileOf(values, 0)).toBe(1);
    expect(percentileOf(values, 1)).toBe(10);
    expect(percentileOf(values, 0.85)).toBe(9);
  });

  test("has no reading for an empty set", () => {
    expect(percentileOf([], 0.5)).toBe(0);
  });
});

describe("medianOf", () => {
  test("ignores a blink when measuring the resting lid", () => {
    expect(medianOf([0.2, 0.22, 0.9, 0.21, 0.2])).toBeCloseTo(0.21);
  });

  test("averages the middle pair for an even count", () => {
    expect(medianOf([1, 4, 2, 3])).toBe(2.5);
  });
});
