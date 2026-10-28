/**
 * Turns MediaPipe face landmarks and blendshapes into the values the rig wants.
 *
 * Kept free of the MediaPipe runtime so the sign conventions can be tested
 * without a model or a camera.
 *
 * MediaPipe names eyes from the *subject's* point of view, while the rig names
 * them from the viewer's. The raw camera image is not mirrored, so the subject's
 * left eye is on the viewer's right: `blinkLeft` here means the rig's left eye,
 * which is the landmark group around 33/133 and the `eyeBlinkRight` blendshape.
 * The mouth corners and the cheeks follow the same rule.
 */

/** One reading, in the units the rig wants. */
export interface FaceSample {
  /**
   * Head offset from the calibrated centre, -1..1 (+ right on screen, + down).
   * Screen-right like the gaze, not image-right: see `faceSample`.
   */
  x: number;
  y: number;
  /** Lid closure, 0 = open, 1 = shut, per eye as seen by the viewer. */
  blinkLeft: number;
  blinkRight: number;
  /** Where the gaze lands on the monitor, -1..1 (+ right, + down). */
  lookX: number;
  lookY: number;
  /**
   * Cheek raise, 0..1, per side as seen by the viewer. The rig's cheeks follow
   * the cheeks themselves — the cheek squint on that side — and fall back on the
   * mouth corner when the cheek signal is flat.
   */
  cheekLeft: number;
  cheekRight: number;
  /** Brow lowering, 0..1, per eye as seen by the viewer. */
  browLeft: number;
  browRight: number;
  /** Jaw opening, 0 = shut, 1 = wide. */
  mouthOpen: number;
  /** Smile width, 0 = relaxed, 1 = as wide as the calibration measured. */
  mouthWidth: number;
  /** Lower lip width, 0 = narrow, 1 = wide. Follows the smile and the jaw. */
  mouthBottomWidth: number;
  /** Smile at each corner, 0..1, as seen by the viewer. */
  mouthHappyLeft: number;
  mouthHappyRight: number;
  /** Frown at each corner, 0..1, as seen by the viewer. */
  mouthSadLeft: number;
  mouthSadRight: number;
}

/** A landmark as the model reports it: 0..1 across the frame. */
export interface Landmark {
  x: number;
  y: number;
}

/** A blendshape category. */
export interface Shape {
  categoryName?: string;
  score: number;
}

/** What came out of the model before the neutral pose is subtracted. */
export interface RawSample {
  /** Midpoint of the outer eye corners, 0..1 in the camera frame. */
  x: number;
  y: number;
  /** Head turn, positive towards the viewer's right. */
  yaw: number;
  /** Head tilt, positive when the chin drops (looking down). */
  pitch: number;
  /** Eye aperture (lid gap ÷ eye width), per eye as seen by the viewer. */
  lidLeft: number;
  lidRight: number;
  /** Blink blendshape scores, per eye as seen by the viewer. */
  blinkLeft: number;
  blinkRight: number;
  /** Eye-in-head direction, -1..1, positive towards the viewer's right / up. */
  lookH: number;
  lookV: number;
  /** Mouth corner score, 0..1, per side as seen by the viewer. */
  smileLeft: number;
  smileRight: number;
  /** Mouth frown score, 0..1, per side as seen by the viewer. */
  frownLeft: number;
  frownRight: number;
  /** Jaw opening score, 0..1. */
  jawOpen: number;
  /** Cheek raise score, 0..1, per side as seen by the viewer. */
  cheekSquintLeft: number;
  cheekSquintRight: number;
  /** Brow lowering score, per eye as seen by the viewer. */
  browDownLeft: number;
  browDownRight: number;
}

export interface Neutral extends RawSample {
  calibrated: boolean;
}

/** One eye's measurements with the lids open and shut. */
export interface EyeRange {
  scoreLeft: number;
  lidLeft: number;
  scoreRight: number;
  lidRight: number;
}

/** One axis of the gaze map: how far a raw signal moves the look, per unit. */
export interface GazeAxisFit {
  /** Head turn (yaw) or nod (pitch), in monitor widths per unit. */
  head: number;
  /** Eyes in their sockets (lookH/lookV), in monitor widths per unit. */
  eye: number;
}

/**
 * The gaze map measured by following the cursor.
 *
 * The calibration sweeps the pointer across the screen while the person
 * follows it, and a least-squares fit learns how much of the look comes from
 * the head and how much from the eyes, and how far each travels. The neutral
 * pose is the zero, so the fit is the offset from the middle of the screen.
 */
export interface GazeCalibration {
  x: GazeAxisFit;
  y: GazeAxisFit;
}

export interface Calibration {
  /** The resting pose: the zero for every value, and the gaze's centre. */
  neutral: Neutral;
  /** Eyes shut: the one for the blink. */
  shut: EyeRange;
  /**
   * The eyes wide open while the gaze travelled the screen during the cursor
   * follow. The blink is measured from here, not from the resting pose, so
   * merely looking around cannot read as a blink.
   */
  open: EyeRange;
  /** The measured gaze map; null until the cursor follow has been fitted. */
  gaze: GazeCalibration | null;
  /** Cheeks and smile at their widest, which is what makes them reach 1. */
  cheek: CheekRange;
  /** Jaw at its widest, which is what makes a full opening reach 1. */
  jawMax: number;
  /** Lowest brows measured, per eye as seen by the viewer. */
  browMaxLeft: number;
  browMaxRight: number;
  /** Deepest frown measured, per side as seen by the viewer. */
  frownMaxLeft: number;
  frownMaxRight: number;
}

/** The cheek signals at the widest smile that was measured. */
export interface CheekRange {
  /** Mouth corners, per side as seen by the viewer. */
  smileLeft: number;
  smileRight: number;
  /** Cheek raise, per side as seen by the viewer. */
  squintLeft: number;
  squintRight: number;
}

/** Head offset is multiplied by this to cover the rig's -1..1. */
const HEAD_GAIN_X = 2.6;
const HEAD_GAIN_Y = 2.6;
/** Makes an everyday jaw score reach the rig's fully open mouth. */
const JAW_GAIN = 1.5;
/**
 * Smallest measured range that counts as movement. The calibration records how
 * far a signal actually travels on this person; anything flatter than this is
 * noise, and is ignored so a step that was skipped cannot invent a pose.
 */
const SCORE_RANGE_MIN = 0.08;
const LID_RANGE_MIN = 0.03;
/**
 * Blendshape spans the mouth falls back on when its range was not measured, or
 * was too flat to use. Unlike the lids, a mouth channel stuck at zero reads as
 * a broken rig; a rough response is better than none, and the calibration still
 * refines it when a real range is found.
 */
const SMILE_SPAN = 0.8;
const FROWN_SPAN = 0.5;
/** Share of the measured range ignored at rest, so a relaxed face sits at zero. */
const RANGE_DEADZONE = 0.08;
/**
 * How far one eye's blink score may sit behind the other's and still count.
 * MediaPipe lifts both eyes when only one is winking; the gap keeps the open
 * eye open, while two eyes blinking together stay within it.
 */
const WINK_MARGIN = 0.35;
/**
 * Share of a full frown that presses the lid gap shut. Lowering the brows
 * squeezes the upper lid down, so a hard frown narrows the measured gap even
 * though the eye has not blinked.
 */
const BROW_LID_LEAK = 0.45;
/** The blink score picks up less of a frown than the geometric gap does. */
const BROW_SCORE_LEAK = 0.3;

/** The neutral pose before anything has been measured. */
export const NEUTRAL_UNMEASURED: Neutral = {
  x: 0.5,
  y: 0.5,
  yaw: 0,
  pitch: 0,
  lidLeft: 0.3,
  lidRight: 0.3,
  blinkLeft: 0.25,
  blinkRight: 0.25,
  lookH: 0,
  lookV: 0,
  smileLeft: 0,
  smileRight: 0,
  frownLeft: 0,
  frownRight: 0,
  jawOpen: 0,
  cheekSquintLeft: 0,
  cheekSquintRight: 0,
  browDownLeft: 0,
  browDownRight: 0,
  calibrated: false,
};

/** The calibration before anything has been measured. */
export const NO_CALIBRATION: Calibration = {
  neutral: { ...NEUTRAL_UNMEASURED },
  shut: { scoreLeft: 0.9, lidLeft: 0.02, scoreRight: 0.9, lidRight: 0.02 },
  open: { scoreLeft: 0, lidLeft: 1, scoreRight: 0, lidRight: 1 },
  gaze: null,
  cheek: { smileLeft: 1, smileRight: 1, squintLeft: 1, squintRight: 1 },
  jawMax: 1,
  browMaxLeft: 1,
  browMaxRight: 1,
  frownMaxLeft: 1,
  frownMaxRight: 1,
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Distance in frame units, with x scaled so the measurement is not squashed. */
function span(a: Landmark, b: Landmark, aspect: number): number {
  return Math.hypot((a.x - b.x) * aspect, a.y - b.y);
}

/**
 * Reads one frame's landmarks.
 *
 * The look has two parts, and a face needs both: the eyes in their sockets (the
 * `eyeLook*` blendshapes) and the direction the head itself points. Turning the
 * head towards a screen corner barely moves the pupils, so eye-only tracking
 * follows the eyeball, not the thing being looked at.
 *
 * The head direction is measured from the nose: it sits forward of the face
 * plane, so it swings towards the side the head turns to, and drops in the frame
 * when the chin drops.
 */
export function readFace(
  landmarks: Landmark[],
  shapes: Shape[],
  aspect = 4 / 3,
): RawSample | null {
  const outerLeft = landmarks[33];
  const innerLeft = landmarks[133];
  const innerRight = landmarks[362];
  const outerRight = landmarks[263];
  const nose = landmarks[1];
  const edgeLeft = landmarks[234];
  const edgeRight = landmarks[454];
  if (
    !outerLeft ||
    !innerLeft ||
    !innerRight ||
    !outerRight ||
    !nose ||
    !edgeLeft ||
    !edgeRight
  ) {
    return null;
  }

  const eyeWidth = Math.max(1e-6, span(outerLeft, innerLeft, aspect));
  const eyeWidthRight = Math.max(1e-6, span(innerRight, outerRight, aspect));
  const score = new Map(shapes.map((shape) => [shape.categoryName ?? "", shape.score]));
  const value = (name: string) => score.get(name) ?? 0;

  // The eye-corner midpoint barely moves when the eyes look around, so the head
  // stays still while only the pupils travel.
  const eyeMidX = (outerLeft.x + outerRight.x) / 2;
  const eyeMidY = (outerLeft.y + outerRight.y) / 2;

  const faceWidth = Math.max(1e-6, Math.abs(edgeRight.x - edgeLeft.x));
  const faceCentreX = (edgeRight.x + edgeLeft.x) / 2;

  return {
    x: eyeMidX,
    y: eyeMidY,
    // Per half face width, so it does not shrink as the person moves away.
    yaw: (nose.x - faceCentreX) / (faceWidth / 2),
    pitch: (nose.y - eyeMidY) / (faceWidth / 2),
    lidLeft: aperture(landmarks[159], landmarks[145], eyeWidth, aspect),
    lidRight: aperture(landmarks[386], landmarks[374], eyeWidthRight, aspect),
    // The viewer's left eye is the subject's right one.
    blinkLeft: value("eyeBlinkRight"),
    blinkRight: value("eyeBlinkLeft"),
    lookH:
      (value("eyeLookOutLeft") +
        value("eyeLookInRight") -
        value("eyeLookInLeft") -
        value("eyeLookOutRight")) /
      2,
    lookV:
      (value("eyeLookUpLeft") +
        value("eyeLookUpRight") -
        value("eyeLookDownLeft") -
        value("eyeLookDownRight")) /
      2,
    smileLeft: value("mouthSmileRight"),
    smileRight: value("mouthSmileLeft"),
    // The subject's left is the viewer's right, as with the smile.
    frownLeft: value("mouthFrownRight"),
    frownRight: value("mouthFrownLeft"),
    jawOpen: value("jawOpen"),
    // The cheek raise that comes with a real smile, per side.
    cheekSquintLeft: value("cheekSquintRight"),
    cheekSquintRight: value("cheekSquintLeft"),
    // Again, the subject's left is the viewer's right.
    browDownLeft: value("browDownRight"),
    browDownRight: value("browDownLeft"),
  };
}

function aperture(
  upper: Landmark | undefined,
  lower: Landmark | undefined,
  eyeWidth: number,
  aspect: number,
): number {
  if (!upper || !lower) {
    return 0;
  }
  return span(upper, lower, aspect) / eyeWidth;
}

/**
 * Where a look lands on the monitor, 0..1, from the measured gaze map.
 *
 * The neutral pose is the zero and the middle of the screen. Both raw signals
 * are used per axis: the head direction (yaw/pitch) and the eyes in their
 * sockets (lookH/lookV), weighted by how much each actually moves this face.
 */
export function gazePoint(
  raw: RawSample,
  neutral: RawSample,
  fit: GazeCalibration,
): { u: number; v: number } {
  return {
    u:
      0.5 +
      fit.x.head * (raw.yaw - neutral.yaw) +
      fit.x.eye * (raw.lookH - neutral.lookH),
    v:
      0.5 +
      fit.y.head * (raw.pitch - neutral.pitch) +
      fit.y.eye * (raw.lookV - neutral.lookV),
  };
}

/** A frame of the cursor follow: what the face did, and where the pointer was. */
export interface GazeTracePoint {
  raw: RawSample;
  /** Cursor position, 0..1 across the monitor. */
  u: number;
  v: number;
}

/**
 * Fits the gaze map from the cursor trace: least squares over both axes.
 *
 * The head and the eyes turn together when following a cursor, which leaves
 * their two signals correlated. A little ridge on the normal equations keeps
 * the solve stable when one of them barely moved (a person who tracks the
 * cursor with their eyes alone), so the fit still learns the one that did.
 */
export function fitGaze(
  trace: readonly GazeTracePoint[],
  neutral: RawSample,
): GazeCalibration | null {
  if (trace.length === 0) {
    return null;
  }

  const x = fitAxis(
    trace,
    (raw) => raw.yaw - neutral.yaw,
    (raw) => raw.lookH - neutral.lookH,
    (point) => point.u - 0.5,
  );
  const y = fitAxis(
    trace,
    (raw) => raw.pitch - neutral.pitch,
    (raw) => raw.lookV - neutral.lookV,
    (point) => point.v - 0.5,
  );

  return x && y ? { x, y } : null;
}

function fitAxis(
  trace: readonly GazeTracePoint[],
  headOf: (raw: RawSample) => number,
  eyeOf: (raw: RawSample) => number,
  targetOf: (point: GazeTracePoint) => number,
): GazeAxisFit | null {
  let headSquare = 0;
  let headEye = 0;
  let eyeSquare = 0;
  let headTarget = 0;
  let eyeTarget = 0;

  for (const point of trace) {
    const head = headOf(point.raw);
    const eye = eyeOf(point.raw);
    const target = targetOf(point);
    headSquare += head * head;
    headEye += head * eye;
    eyeSquare += eye * eye;
    headTarget += head * target;
    eyeTarget += eye * target;
  }

  // Nothing moved on this axis: the middle of the screen is all it can say.
  const total = headSquare + eyeSquare;
  if (total < 1e-9) {
    return { head: 0, eye: 0 };
  }

  // Ridge keeps the determinant away from zero without visibly biasing a fit
  // that has real movement in both signals. It is what lets a person who tracks
  // the cursor with their eyes alone still be fitted.
  const ridge = total * 0.001;
  const headDiag = headSquare + ridge;
  const eyeDiag = eyeSquare + ridge;
  const determinant = headDiag * eyeDiag - headEye * headEye;
  if (!(determinant > 0)) {
    return null;
  }

  return {
    head: (headTarget * eyeDiag - eyeTarget * headEye) / determinant,
    eye: (eyeTarget * headDiag - headTarget * headEye) / determinant,
  };
}

/**
 * Subtracts the neutral pose and scales the result into the rig's units.
 *
 * The gaze is the head direction plus the eyes in their sockets: both turn the
 * same way, so they add up. That is what makes the face look at the same place
 * on the monitor as the person, including when they only turn their head. The
 * scale from the corner poses then makes that reach the edge of the eye, which
 * is what keeps looking at a screen corner looking like a corner.
 */
export function faceSample(raw: RawSample, calibration: Calibration): FaceSample {
  const neutral = calibration.neutral;
  const calibrated = neutral.calibrated;

  // The rig's look is screen-relative, like the manual cursor gaze: looking at
  // the right of the screen moves the pupils to the right of the picture. The
  // fitted map already has that sign, learned from the cursor trace.
  const fit = calibrated ? calibration.gaze : null;
  const gaze = fit ? gazePoint(raw, neutral, fit) : { u: 0.5, v: 0.5 };

  // The blink score and the lid gap are both measured against this person's own
  // rest and shut poses. A score that plateaus at 0.65 still reaches 1 here.
  // The resting pose and the open-eyed corner poses are both "open": the
  // stronger of the two is the one that counts as nothing, so the score and the
  // gap shifting with the gaze do not read as a blink.
  const openScoreLeft = Math.max(neutral.blinkLeft, calibration.open.scoreLeft);
  const openScoreRight = Math.max(neutral.blinkRight, calibration.open.scoreRight);
  const openLidLeft = Math.min(neutral.lidLeft, calibration.open.lidLeft);
  const openLidRight = Math.min(neutral.lidRight, calibration.open.lidRight);

  const scoreLeft = ratio(
    raw.blinkLeft,
    openScoreLeft,
    calibration.shut.scoreLeft,
    SCORE_RANGE_MIN,
  );
  const scoreRight = ratio(
    raw.blinkRight,
    openScoreRight,
    calibration.shut.scoreRight,
    SCORE_RANGE_MIN,
  );

  // Mouth corners are measured per side, then combined for the mouth and the
  // cheeks. The smile widens the mouth; the frown grows the covers that hide the
  // smile corners. A smile wins over a simultaneously reported frown.
  const smileLeft = expressionRatio(
    raw.smileLeft,
    neutral.smileLeft,
    calibration.cheek.smileLeft,
    SMILE_SPAN,
  );
  const smileRight = expressionRatio(
    raw.smileRight,
    neutral.smileRight,
    calibration.cheek.smileRight,
    SMILE_SPAN,
  );
  const smile = Math.max(smileLeft, smileRight);
  const frownLeft = expressionRatio(
    raw.frownLeft,
    neutral.frownLeft,
    calibration.frownMaxLeft,
    FROWN_SPAN,
  );
  const frownRight = expressionRatio(
    raw.frownRight,
    neutral.frownRight,
    calibration.frownMaxRight,
    FROWN_SPAN,
  );

  // A cheek follows the cheek itself, and the mouth corner is the fallback: a
  // smile with the eyes raises the cheek even when the lips barely move, and a
  // mouth-only smile still moves it on faces where the cheek score stays low.
  const cheekLeft = calibrated
    ? Math.max(
        smileLeft,
        ratio(
          raw.cheekSquintLeft,
          neutral.cheekSquintLeft,
          calibration.cheek.squintLeft,
          SCORE_RANGE_MIN,
        ),
      )
    : 0;
  const cheekRight = calibrated
    ? Math.max(
        smileRight,
        ratio(
          raw.cheekSquintRight,
          neutral.cheekSquintRight,
          calibration.cheek.squintRight,
          SCORE_RANGE_MIN,
        ),
      )
    : 0;

  // The jaw score is close to 0..1 already, but the resting face may sit above
  // zero: subtract the neutral pose. A measured wide-open pose makes that the
  // new 1; a gain follows an ordinary speaking jaw, which sits well below the
  // widest the calibration measured. Unlike the expressions, this deliberately
  // skips the range dead zone: a small jaw movement is a real opening, not
  // resting noise, and should move the lip from the first frame.
  const jawRange = calibration.jawMax - neutral.jawOpen;
  const jaw =
    calibrated && jawRange >= SCORE_RANGE_MIN
      ? clamp(((raw.jawOpen - neutral.jawOpen) / jawRange) * JAW_GAIN, 0, 1)
      : clamp((raw.jawOpen - neutral.jawOpen) * JAW_GAIN, 0, 1);

  // Brow lowering, per side as seen by the viewer.
  const browLeft = calibrated
    ? ratio(raw.browDownLeft, neutral.browDownLeft, calibration.browMaxLeft, SCORE_RANGE_MIN)
    : 0;
  const browRight = calibrated
    ? ratio(raw.browDownRight, neutral.browDownRight, calibration.browMaxRight, SCORE_RANGE_MIN)
    : 0;

  // A frown presses the upper lid down, so the gap and the blink score both
  // move a little without a blink. That share of the brow movement is taken
  // back below, so a frown does not read as half-closed eyes.
  const scoreLeftOpen = discountFrown(scoreLeft, browLeft, BROW_SCORE_LEAK);
  const scoreRightOpen = discountFrown(scoreRight, browRight, BROW_SCORE_LEAK);
  const lidLeftOpen = discountFrown(
    ratio(raw.lidLeft, openLidLeft, calibration.shut.lidLeft, LID_RANGE_MIN),
    browLeft,
    BROW_LID_LEAK,
  );
  const lidRightOpen = discountFrown(
    ratio(raw.lidRight, openLidRight, calibration.shut.lidRight, LID_RANGE_MIN),
    browRight,
    BROW_LID_LEAK,
  );

  return {
    x: calibrated ? clamp(-(raw.x - neutral.x) * HEAD_GAIN_X, -1, 1) : 0,
    y: calibrated ? clamp((raw.y - neutral.y) * HEAD_GAIN_Y, -1, 1) : 0,
    blinkLeft: calibrated ? closure(scoreLeftOpen, lidLeftOpen, scoreRightOpen) : 0,
    blinkRight: calibrated ? closure(scoreRightOpen, lidRightOpen, scoreLeftOpen) : 0,
    lookX: clamp(gaze.u * 2 - 1, -1, 1),
    lookY: clamp(gaze.v * 2 - 1, -1, 1),
    cheekLeft,
    cheekRight,
    browLeft,
    browRight,
    mouthOpen: jaw,
    mouthWidth: smile,
    mouthBottomWidth: Math.max(smile, jaw),
    mouthHappyLeft: smileLeft,
    mouthHappyRight: smileRight,
    mouthSadLeft: Math.max(0, frownLeft - smileLeft),
    mouthSadRight: Math.max(0, frownRight - smileRight),
  };
}

/**
 * A mouth blendshape as 0..1, using the measured range when there is one and a
 * fixed span when the range is missing or too flat to trust.
 */
function expressionRatio(
  value: number,
  from: number,
  to: number,
  fallbackSpan: number,
): number {
  const span = to - from;
  if (Math.abs(span) < SCORE_RANGE_MIN) {
    return clamp((value - from) / fallbackSpan, 0, 1);
  }
  return ratio(value, from, to, SCORE_RANGE_MIN);
}

/**
 * Takes back the closure a frown presses shut.
 *
 * `share` is how much of a full brow movement that is, and the discount fades
 * as the closure reaches 1: a frown cannot loosen a lid that is already shut,
 * so a real blink is still allowed all the way.
 */
export function discountFrown(closure: number, brow: number, share: number): number {
  return Math.max(0, closure - brow * share * (1 - closure));
}

/**
 * Where a value sits between the two poses the calibration measured, 0..1.
 *
 * `from` is the relaxed end and `to` the extreme, which may be lower for a lid
 * gap. A range flatter than `minimum` returns 0: the signal does not move on
 * this face, so it cannot be trusted to say anything.
 */
export function ratio(value: number, from: number, to: number, minimum: number): number {
  const span = to - from;
  if (Math.abs(span) < minimum) {
    return 0;
  }

  const covered = (value - from) / span;
  return clamp((covered - RANGE_DEADZONE) / (1 - RANGE_DEADZONE), 0, 1);
}

/**
 * Turns a blink into lid closure, 0..1.
 *
 * Two measures, and the stronger wins: the blendshape score and the geometric
 * lid gap. Either can be the one that moves — the score plateaus well below 1 on
 * many faces, while the mesh often keeps drawing the open eye outline on a shut
 * one — so both are normalised to the calibration and neither is required.
 *
 * The score is dropped when it sits well behind the other eye: a wink lifts both
 * scores, and only the lid that actually moved may close.
 */
export function closure(byScore: number, byLid: number, otherScore: number): number {
  const score = byScore + WINK_MARGIN >= otherScore ? byScore : 0;
  return clamp(Math.max(byLid, score), 0, 1);
}

/** Median of the readings, used so a blink cannot pull the neutral pose down. */
export function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/**
 * The reading at a quantile, 0..1.
 *
 * The cursor follow is a long take, and the person will blink during it. A
 * percentile reads the edge of the open-eye range without letting a handful of
 * blinks (high scores, low gaps) set it.
 */
export function percentileOf(values: number[], quantile: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.round(clamp(quantile, 0, 1) * (sorted.length - 1));
  return sorted[index];
}
