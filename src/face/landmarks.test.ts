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
  /** Inner-lip gap, in frame units. */
  mouthGap?: number;
  /** Iris offset from the eye centre, in frame units. */
  irisDx?: number;
  irisDy?: number;
  /** How far the nose bridge (168/6) drifts, in frame units. */
  bridgeDy?: number;
  /** Brow lowering, in frame units, per viewer side; positive lowers. */
  browLeftDy?: number;
  browRightDy?: number;
  /** Mouth-corner drop below the upper lip, in frame units. */
  mouthDrop?: number;
  /** Mouth corners shifted together, in frame units. */
  mouthDx?: number;
  mouthDy?: number;
  /** One corner down and the other up by this much, in frame units. */
  mouthTwist?: number;
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

  // Iris centres, at the middle of each eye at rest, with their four ring
  // points; the reader averages the five, so the ring must be symmetric.
  const irisDx = options.irisDx ?? 0;
  const irisDy = options.irisDy ?? 0;
  const ring = 0.005;
  const leftX = 0.36 + irisDx;
  const rightX = 0.64 + irisDx;
  const middleY = 0.4 + irisDy;
  marks[468] = { x: leftX, y: middleY };
  marks[469] = { x: leftX - ring, y: middleY };
  marks[470] = { x: leftX, y: middleY + ring };
  marks[471] = { x: leftX + ring, y: middleY };
  marks[472] = { x: leftX, y: middleY - ring };
  marks[473] = { x: rightX, y: middleY };
  marks[474] = { x: rightX - ring, y: middleY };
  marks[475] = { x: rightX, y: middleY + ring };
  marks[476] = { x: rightX + ring, y: middleY };
  marks[477] = { x: rightX, y: middleY - ring };

  // Eyebrow ridges, a tenth of the frame above the eye line. Each brow is five
  // points; the reader averages them, so only their height matters here.
  const browLeftDy = options.browLeftDy ?? 0;
  const browRightDy = options.browRightDy ?? 0;
  [70, 63, 105, 66, 107].forEach((id, index) => {
    marks[id] = { x: 0.3 + index * 0.03, y: 0.3 + browLeftDy };
  });
  [336, 296, 334, 293, 300].forEach((id, index) => {
    marks[id] = { x: 0.58 + index * 0.03, y: 0.3 + browRightDy };
  });

  marks[234] = { x: 0.16, y: 0.5 };
  marks[454] = { x: 0.84, y: 0.5 };
  const mouthGap = options.mouthGap ?? 0;
  marks[13] = { x: 0.5, y: 0.6 - mouthGap / 2 };
  marks[14] = { x: 0.5, y: 0.6 + mouthGap / 2 };
  const mouthDrop = options.mouthDrop ?? 0;
  const mouthDx = options.mouthDx ?? 0;
  const mouthDy = options.mouthDy ?? 0;
  const twist = options.mouthTwist ?? 0;
  marks[61] = { x: 0.42 + mouthDx, y: 0.6 + mouthDrop + mouthDy - twist };
  marks[291] = { x: 0.58 + mouthDx, y: 0.6 + mouthDrop + mouthDy + twist };
  marks[1] = { x: 0.5 + (options.noseDx ?? 0), y: 0.45 + (options.noseDy ?? 0) };
  const bridgeDy = options.bridgeDy ?? 0;
  marks[168] = { x: 0.5, y: 0.5 + bridgeDy };
  marks[6] = { x: 0.5, y: 0.5 + bridgeDy };
  return marks;
}

const shapes = (scores: Record<string, number>): Shape[] =>
  Object.entries(scores).map(([categoryName, score]) => ({ categoryName, score }));

const read = (options: FaceOptions = {}, scores: Record<string, number> = {}): RawSample =>
  readFace(face(options), shapes(scores))!;

/**
 * Rolls the whole synthetic face around the eye line, in physical units (x
 * scaled by the frame's aspect) so the angle is a real head roll.
 */
function roll(marks: Landmark[], angle: number, aspect = 4 / 3): Landmark[] {
  const cx = 0.5 * aspect;
  const cy = 0.4;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return marks.map(({ x, y }) => {
    const dx = x * aspect - cx;
    const dy = y - cy;
    return { x: (cx + dx * cos - dy * sin) / aspect, y: cy + dx * sin + dy * cos };
  });
}

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
  jawMax: 0.5,
  mouthGapMax: 0.2,
  mouthDropMax: rest.mouthDrop + 0.04,
  browMaxLeft: -0.5,
  browMaxRight: -0.5,
  frownMaxLeft: 1,
  frownMaxRight: 1,
  ...overrides,
});

describe("readFace", () => {
  test("measures head position from the middle of the eye line", () => {
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

  test("maps the subject's eye-wide score to the viewer's other side", () => {
    const raw = read({}, { eyeWideLeft: 0.8, eyeWideRight: 0.2 });
    expect(raw.eyeWideRight).toBeCloseTo(0.8);
    expect(raw.eyeWideLeft).toBeCloseTo(0.2);
  });

  test("reads the look from the iris, not the eyelid-driven scores", () => {
    // MediaPipe reports an upward look when the eyes widen; the iris is centred.
    const rest = read();
    const wide = read(
      {},
      { eyeWideLeft: 0.9, eyeWideRight: 0.9, eyeLookUpLeft: 0.6, eyeLookUpRight: 0.6 },
    );
    expect(wide.lookV).toBeCloseTo(rest.lookV, 6);
  });

  test("keeps the look still when the eyes bulge", () => {
    const rest = read();
    const bulged = read({ lidGap: 0.06 }, { eyeWideLeft: 0.9, eyeWideRight: 0.9 });
    expect(bulged.lookH).toBeCloseTo(rest.lookH, 6);
    expect(bulged.lookV).toBeCloseTo(rest.lookV, 6);
  });

  test("keeps the look and the head still when a bulge lifts the brow", () => {
    const rest = read();
    // Opening the eyes wide lifts the brows, and with them the bridge the head
    // and the gaze used to be measured from. Neither may follow it.
    const bulged = read(
      { lidGap: 0.06, bridgeDy: -0.02 },
      { eyeWideLeft: 0.9, eyeWideRight: 0.9 },
    );
    expect(bulged.lookH).toBeCloseTo(rest.lookH, 6);
    expect(bulged.lookV).toBeCloseTo(rest.lookV, 6);
    expect(bulged.x).toBeCloseTo(rest.x, 6);
    expect(bulged.y).toBeCloseTo(rest.y, 6);
    expect(bulged.yaw).toBeCloseTo(rest.yaw, 6);
    expect(bulged.pitch).toBeCloseTo(rest.pitch, 6);
  });

  test("measures the look in the eye's frame, so a head roll does not tilt it", () => {
    const level = read({ irisDx: 0.02 });
    const rolled = readFace(roll(face({ irisDx: 0.02 }), 0.3), [])!;
    expect(rolled.lookH).toBeCloseTo(level.lookH, 5);
    expect(rolled.lookV).toBeCloseTo(level.lookV, 5);
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
    // "in right" are the same direction. The iris travelling past the eye's
    // middle is a look to that side.
    expect(read({ irisDx: 0.02 }).lookH).toBeCloseTo(0.1667, 3);
  });

  test("turns towards the viewer's left when the right eye looks out", () => {
    expect(read({ irisDx: -0.02 }).lookH).toBeCloseTo(-0.1667, 3);
  });

  test("reports an upward look as positive", () => {
    const rest = read();
    expect(read({ irisDy: -0.01 }).lookV - rest.lookV).toBeCloseTo(0.0625, 3);
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

  test("measures the inner-lip gap against the face width", () => {
    // The synthetic face is 0.68 wide, scaled by the 4/3 frame aspect.
    const raw = read({ mouthGap: 0.02 });
    expect(raw.mouthGap).toBeCloseTo(0.02 / (0.68 * (4 / 3)), 5);
  });

  test("reads lip rounding from the pucker and funnel scores", () => {
    const raw = read({}, { mouthPucker: 0.4, mouthFunnel: 0.7 });
    expect(raw.mouthPucker).toBeCloseTo(0.7, 5);
  });

  test("measures the mouth-corner drop against the face width", () => {
    // The drop is measured from the nose, so compare the change from rest.
    const rest = read();
    const sad = read({ mouthDrop: 0.03 });
    expect(sad.mouthDrop - rest.mouthDrop).toBeCloseTo(0.03 / (0.68 * (4 / 3)), 5);
  });

  test("measures where the mouth sits relative to the nose", () => {
    const rest = read();
    const moved = read({ mouthDx: 0.04, mouthDy: 0.02 });
    expect(moved.mouthX - rest.mouthX).toBeCloseTo(0.04 / (0.68 * (4 / 3)), 5);
    expect(moved.mouthY - rest.mouthY).toBeCloseTo(0.02 / (0.68 * (4 / 3)), 5);
  });

  test("reads a twisted mouth, positive when the right corner drops", () => {
    const rest = read();
    const twisted = read({ mouthTwist: 0.02 });
    expect(twisted.mouthTilt).toBeGreaterThan(rest.mouthTilt);
    // The corners move 0.04 apart; over the 0.16 · 4/3 physical span that is a
    // clear angle of about 0.19 rad.
    expect(twisted.mouthTilt - rest.mouthTilt).toBeGreaterThan(0.15);
  });

  test("ignores a head roll, which turns both lines together", () => {
    const rest = read();
    const rolled = readFace(roll(face(), 0.2), [])!;
    expect(rolled.mouthTilt).toBeCloseTo(rest.mouthTilt, 2);
  });

  test("measures each brow above its own eye line", () => {
    // The viewer's left brow dropped by 0.02 of the frame; the other did not
    // move. The eye is 0.16 wide, and the ridge started 0.10 above the line.
    const raw = read({ browLeftDy: 0.02 });
    expect(raw.browDownLeft).toBeCloseTo(-0.5);
    expect(raw.browDownRight).toBeCloseTo(-0.625);
  });

  test("reads the ridge, not the score that answers to the lids", () => {
    const rest = read();
    // The model's brow score rises when the upper lid comes near the brow, with
    // the brow itself still; a wide or upward-looking eye must not close it.
    const glance = read({ lidGap: 0.05 }, { browDownLeft: 0.9, browDownRight: 0.9 });
    expect(glance.browDownLeft).toBeCloseTo(rest.browDownLeft, 6);
    expect(glance.browDownRight).toBeCloseTo(rest.browDownRight, 6);
  });
});

describe("faceSample", () => {
  test("subtracts the neutral head position", () => {
    const rest = read();
    const moved = readFace(face({ noseDx: 0 }), [])!;
    // The head sat 0.05 up the frame from the neutral eye line (0.40).
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
    const glanced = read({ irisDx: 0.06 });
    expect(faceSample(glanced, calibratedWith(rest)).lookX).toBe(-1);
  });

  test("counts an upward look as negative y, because the rig points down", () => {
    const rest = read();
    const glanced = read({ irisDy: -0.04 });
    expect(faceSample(glanced, calibratedWith(rest)).lookY).toBeLessThan(-0.5);
  });

  test("reads the head's own turn, independent of where the eyes look", () => {
    const rest = read();
    const turned = read({ noseDx: 0.05 });
    const sample = faceSample(turned, calibratedWith(rest));
    expect(sample.headYaw).toBeGreaterThan(0.3);
    expect(sample.headPitch).toBeCloseTo(0, 5);
  });

  test("reads a nod as a downward head turn", () => {
    const rest = read();
    const nodded = read({ noseDy: 0.05 });
    expect(faceSample(nodded, calibratedWith(rest)).headPitch).toBeGreaterThan(0.3);
  });

  test("subtracts the calibrated head turn", () => {
    const rest = read({ noseDx: 0.02, noseDy: -0.01 });
    const sample = faceSample(rest, calibratedWith(rest));
    expect(sample.headYaw).toBeCloseTo(0, 5);
    expect(sample.headPitch).toBeCloseTo(0, 5);
  });

  test("holds the head turn at zero until the calibration is measured", () => {
    const sample = faceSample(read({ noseDx: 0.05 }), NO_CALIBRATION);
    expect(sample.headYaw).toBe(0);
    expect(sample.headPitch).toBe(0);
  });

  test("reads a bulge from the wide score and from the lid gap", () => {
    const rest = read();
    // The score alone, with the lid gap unchanged.
    const scored = read({}, { eyeWideLeft: 0.7, eyeWideRight: 0.6 });
    expect(faceSample(scored, calibratedWith(rest)).eyeWide).toBe(1);
    // The aperture alone, past the open reference.
    const gaped = read({ lidGap: 0.05 });
    expect(faceSample(gaped, calibratedWith(rest)).eyeWide).toBeGreaterThan(0.5);
  });

  test("leaves a relaxed or shut eye alone", () => {
    const rest = read();
    expect(faceSample(rest, calibratedWith(rest)).eyeWide).toBe(0);
    expect(faceSample(read({ lidGap: 0 }), calibratedWith(rest)).eyeWide).toBe(0);
  });

  test("holds the eye size until the calibration is measured", () => {
    const sample = faceSample(read({ lidGap: 0.05 }, { eyeWideLeft: 0.8 }), NO_CALIBRATION);
    expect(sample.eyeWide).toBe(0);
  });

  test("moves and twists the mouth from the pose it was calibrated in", () => {
    const rest = read();
    const moved = read({ mouthDx: 0.04, mouthDy: 0.02, mouthTwist: 0.02 });
    const sample = faceSample(moved, calibratedWith(rest));
    expect(sample.mouthShiftX).toBeGreaterThan(0);
    expect(sample.mouthShiftY).toBeGreaterThan(0);
    expect(sample.mouthTilt).toBeGreaterThan(0);
  });

  test("leaves the mouth in place until a neutral pose is measured", () => {
    const sample = faceSample(read({ mouthDx: 0.05, mouthTwist: 0.02 }), NO_CALIBRATION);
    expect(sample.mouthShiftX).toBe(0);
    expect(sample.mouthShiftY).toBe(0);
    expect(sample.mouthTilt).toBe(0);
  });

  test("keeps a resting mouth centred even when it sits off the nose", () => {
    // The calibration's neutral is the zero, so a face that rests with its mouth
    // to one side still starts at the artwork's centre.
    const rest = read({ mouthDx: 0.03, mouthTwist: -0.01 });
    const sample = faceSample(rest, calibratedWith(rest));
    expect(sample.mouthShiftX).toBeCloseTo(0, 5);
    expect(sample.mouthTilt).toBeCloseTo(0, 5);
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
    const frown = read({ browLeftDy: 0.02 });
    const sample = faceSample(frown, calibratedWith(rest));
    expect(sample.browLeft).toBeGreaterThan(0.6);
    expect(sample.browRight).toBe(0);
  });

  test("does not read a frown as a half-closed eye", () => {
    const rest = read({ lidGap: 0.02 });
    const calibration = calibratedWith(rest);

    // A hard frown squeezes the lid gap and nudges the blink score a little.
    const frown = read(
      { lidGap: 0.015, browLeftDy: 0.02, browRightDy: 0.02 },
      { eyeBlinkLeft: 0.15, eyeBlinkRight: 0.15 },
    );
    const sample = faceSample(frown, calibration);

    expect(sample.browLeft).toBeGreaterThan(0.7);
    expect(sample.browRight).toBeGreaterThan(0.7);
    expect(sample.blinkLeft).toBe(0);
    expect(sample.blinkRight).toBe(0);
  });

  test("still shuts the eye on a blink made while frowning", () => {
    const rest = read({ lidGap: 0.02 });
    const calibration = calibratedWith(rest);
    const shut = read(
      { lidGap: 0, browLeftDy: 0.02, browRightDy: 0.02 },
      { eyeBlinkLeft: 0.85, eyeBlinkRight: 0.85 },
    );
    const sample = faceSample(shut, calibration);

    expect(sample.blinkLeft).toBe(1);
    expect(sample.blinkRight).toBe(1);
  });

  test("still closes an eyelid whose shut gap was measured flat", () => {
    const rest = read();
    const calibration = calibratedWith(rest, {
      shut: { scoreLeft: 0.05, lidLeft: 0.12, scoreRight: 0.9, lidRight: 0.02 },
    });
    // The score range is flat too; the gap alone has to carry the blink.
    const shut = read({ lidGap: 0 }, { eyeBlinkRight: 0.1 });
    expect(faceSample(shut, calibration).blinkLeft).toBeGreaterThan(0.5);
  });

  test("still closes an eyelid whose shut score was measured flat", () => {
    const rest = read();
    const calibration = calibratedWith(rest, {
      shut: { scoreLeft: 0.05, lidLeft: 0.02, scoreRight: 0.9, lidRight: 0.02 },
    });
    // The lid gap stays open, so only the score can carry the blink.
    const shut = read({ lidGap: 0.02 }, { eyeBlinkRight: 0.9 });
    expect(faceSample(shut, calibration).blinkLeft).toBeGreaterThan(0.5);
  });

  test("closes a lid whose neutral was remeasured below the shut pose", () => {
    const rest = read({ lidGap: 0.02 });
    const neutral = { ...rest, blinkLeft: 0.75, lidLeft: 0.04 };
    const calibration = calibratedWith(neutral, {
      shut: { scoreLeft: 0.5, lidLeft: 0.02, scoreRight: 0.9, lidRight: 0.02 },
    });
    const shut = read({ lidGap: 0 }, { eyeBlinkRight: 0.9 });
    expect(faceSample(shut, calibration).blinkLeft).toBeGreaterThan(0.5);
  });

  test("widens the mouth with the smile and opens it with the jaw", () => {
    const rest = read();
    const raw = read(
      {},
      {
        jawOpen: 0.2,
        mouthSmileLeft: 0.8,
        mouthSmileRight: 0.8,
        mouthFrownLeft: 0.9,
        mouthFrownRight: 0.9,
      },
    );

    const sample = faceSample(raw, calibratedWith(rest));
    // The jaw is scaled to the measured wide-open pose: 40% of the way there
    // already opens the mouth a good deal, but leaves the top of the range.
    expect(sample.mouthOpen).toBeCloseTo(0.362, 3);
    expect(sample.mouthWidth).toBeCloseTo(0.783, 3);
    expect(sample.mouthBottomWidth).toBeCloseTo(0.783, 3);
    expect(sample.mouthHappyLeft).toBeCloseTo(0.783, 3);
    expect(sample.mouthHappyRight).toBeCloseTo(0.783, 3);
    // A smile hides part of a frown reported at the same time, not all of it.
    expect(sample.mouthSadLeft).toBeCloseTo(0.578, 3);
    expect(sample.mouthSadRight).toBeCloseTo(0.578, 3);
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
    // Unlike the expressions, the jaw has no range dead zone: only the rest
    // floor applies, so a small rise above rest moves the lip off the shut pose.
    const rest = read({}, { jawOpen: 0.01 });
    const sample = faceSample(read({}, { jawOpen: 0.05 }), calibratedWith(rest, { jawMax: 0.6 }));
    expect(sample.mouthOpen).toBeGreaterThan(0.005);
  });

  test("opens the mouth from the lip gap alone", () => {
    // A teeth-showing smile or lip-parted speech moves the inner lips apart
    // while `jawOpen` stays put; the gap has to open the mouth on its own.
    const rest = read({ mouthGap: 0.01 });
    const calibration = calibratedWith(rest);
    expect(faceSample(rest, calibration).mouthOpen).toBe(0);

    const parted = read({ mouthGap: 0.05 });
    expect(faceSample(parted, calibration).mouthOpen).toBeGreaterThan(0.15);
  });

  test("narrows the mouth with rounded lips", () => {
    const rest = read({}, { mouthPucker: 0.1 });
    const rounded = read({}, { mouthPucker: 0.4 });
    expect(faceSample(rounded, calibratedWith(rest)).mouthPucker).toBeCloseTo(0.6, 3);
  });

  test("keeps a frown under a smile on the same side", () => {
    const rest = read();
    // The viewer's left corner is the subject's right blendshape.
    const mixed = read({}, { mouthFrownRight: 0.8, mouthSmileRight: 1 });
    const sample = faceSample(mixed, calibratedWith(rest));
    // The smile hides only part of the frown, so a sad face with a little
    // mouthSmile cross-talk still pulls the corner down.
    expect(sample.mouthSadLeft).toBeGreaterThan(0.3);
  });

  test("pulls the mouth corners down with a lowered brow", () => {
    const rest = read();
    const sad = read({ browLeftDy: 0.02 });
    const sample = faceSample(sad, calibratedWith(rest));
    // A full lowered brow reaches the same sad cut as the calibrated pose, so
    // the corner grows into the LipCorner disc even when the frown is flat.
    expect(sample.mouthSadLeft).toBeGreaterThan(0.8);
  });

  test("pulls the corners down from the lip geometry alone", () => {
    const rest = read();
    const sad = read({ mouthDrop: 0.04 });
    const sample = faceSample(sad, calibratedWith(rest));
    // No frown or brow movement at all, only the corners actually dropping.
    expect(sample.mouthSadLeft).toBeGreaterThan(0.8);
  });

  test("keeps the brow and lip corner working when the measured range is flat", () => {
    // The sad pose lowered the brow by 0.005 of the frame, below the range that
    // counts as a measurement; the fixed span still has to drive the brow and
    // its corner.
    const rest = read({ browLeftDy: 0.005 });
    const sad = read({ browLeftDy: 0.025 });
    const sample = faceSample(sad, calibratedWith(rest, { browMaxLeft: -0.62 }));

    expect(sample.browLeft).toBeGreaterThan(0.8);
    expect(sample.mouthSadLeft).toBeGreaterThan(0.8);
  });

  test("keeps opening the mouth across the measured range", () => {
    // The response is shaped, not a sharp gain: a share of the wide-open pose
    // opens the mouth progressively, and only the full pose reaches the
    // reference, so ordinary speech does not saturate on every word.
    const rest = read({}, { jawOpen: 0.01 });
    const calibration = calibratedWith(rest, { jawMax: 0.51 });
    const quiet = faceSample(read({}, { jawOpen: 0.16 }), calibration);
    const talking = faceSample(read({}, { jawOpen: 0.26 }), calibration);
    const wide = faceSample(read({}, { jawOpen: 0.51 }), calibration);

    expect(quiet.mouthOpen).toBeGreaterThan(0.2);
    expect(talking.mouthOpen).toBeGreaterThan(quiet.mouthOpen);
    expect(talking.mouthOpen).toBeLessThan(0.9);
    expect(wide.mouthOpen).toBe(1);
  });

  test("holds the lips still through jaw noise at rest", () => {
    const rest = read({}, { jawOpen: 0.02 });
    const sample = faceSample(read({}, { jawOpen: 0.028 }), calibratedWith(rest, { jawMax: 0.62 }));
    expect(sample.mouthOpen).toBe(0);
  });

  test("keeps the mouth signals at rest before calibrating", () => {
    const sample = faceSample(read({}, { jawOpen: 0.06 }), NO_CALIBRATION);
    expect(sample.mouthOpen).toBeCloseTo(0.191, 3);
    expect(sample.mouthWidth).toBeCloseTo(0, 5);
    expect(sample.mouthBottomWidth).toBeCloseTo(0.191, 3);
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

  test("learns the eye weight from the corner looks", () => {
    // Positive lookH is a look to the left of the screen.
    const left = read({ irisDx: 0.048 });
    const right = read({ irisDx: -0.048 });
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
