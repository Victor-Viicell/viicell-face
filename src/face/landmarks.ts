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
  /**
   * Head turned away from the calibrated pose, -1..1 (+ right, + down). This is
   * the head itself turning, separate from where the pupils look and from where
   * the head sits in the frame; it moves the whole eye in `FaceRig`.
   */
  headYaw: number;
  headPitch: number;
  /** Lid closure, 0 = open, 1 = shut, per eye as seen by the viewer. */
  blinkLeft: number;
  blinkRight: number;
  /**
   * Eye bulged wider than its baseline, 0..1, for the pair. The tracker shrinks
   * the iris and thins the pupil slit with it; 0 with a relaxed eye.
   */
  eyeWide: number;
  /**
   * The blendshape half of the bulge, 0..1. The tracker holds the gaze and head
   * lean on this signal while it is high: a wide-eyed expression distorts the
   * landmarks the gaze is measured from, and the pupils should keep looking
   * where they were.
   */
  eyeWideScore: number;
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
  /** Lip rounding, 0 = relaxed, 1 = fully narrowed (an "o" or "u" shape). */
  mouthPucker: number;
  /** Lower lip width, 0 = narrow, 1 = wide. Follows the smile and the jaw. */
  mouthBottomWidth: number;
  /** Smile at each corner, 0..1, as seen by the viewer. */
  mouthHappyLeft: number;
  mouthHappyRight: number;
  /** Frown at each corner, 0..1, as seen by the viewer. */
  mouthSadLeft: number;
  mouthSadRight: number;
  /**
   * Mouth shifted away from its resting place, -1..1 (+ right, + down on
   * screen). The whole mouth travels: the lips, the gap and both corner cuts.
   */
  mouthShiftX: number;
  mouthShiftY: number;
  /** Mouth twisted at the corners, -1..1 (+ clockwise on screen). */
  mouthTilt: number;
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
  /** Middle of the eye line, 0..1 in the camera frame; the stable head anchor. */
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
  /** Eye-wide blendshape scores, per eye as seen by the viewer. */
  eyeWideLeft: number;
  eyeWideRight: number;
  /**
   * Eye-in-head direction in eye widths, positive towards the viewer's right /
   * up. Measured from the iris against the eye's own corners and axis, with the
   * blendshape scores as the fallback when the iris points are missing.
   */
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
  /** Inner-lip gap (lower lip − upper lip), as a share of face width. */
  mouthGap: number;
  /** Mouth-corner drop below the inner upper lip, as a share of face width. */
  mouthDrop: number;
  /** Lip rounding score (`mouthPucker` or `mouthFunnel`), 0..1. */
  mouthPucker: number;
  /** Mouth-corner midpoint relative to the nose, as a share of face width. */
  mouthX: number;
  mouthY: number;
  /**
   * Mouth-corner line relative to the eye line, in radians. The eye line is the
   * head's own roll, so a tilted head cancels out and only a twisted mouth
   * reads; positive when the viewer's right corner is lower.
   */
  mouthTilt: number;
  /** Cheek raise score, 0..1, per side as seen by the viewer. */
  cheekSquintLeft: number;
  cheekSquintRight: number;
  /**
   * Brow lowering, in eye widths: positive when the ridge sits below its rest
   * height above the eye line. Measured geometrically, per eye as seen by the
   * viewer; the blendshape of the same name was dragged by the eyelids.
   */
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
 * The gaze map measured by looking at the four monitor corners.
 *
 * The calibration pairs each corner hold with the point on the screen it was
 * aimed at, and a least-squares fit learns how much of the look comes from the
 * head and how much from the eyes, and how far each travels. The neutral pose is
 * the zero, so the fit is the offset from the middle of the screen.
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
   * The eyes wide open while the gaze visited each corner during the pupils
   * calibration. The blink is measured from here, not from the resting pose, so
   * merely looking around cannot read as a blink.
   */
  open: EyeRange;
  /** The measured gaze map; null until the corner looks have been fitted. */
  gaze: GazeCalibration | null;
  /** Cheeks and smile at their widest, which is what makes them reach 1. */
  cheek: CheekRange;
  /** Jaw at its widest; 0 when no wide-open pose has been measured. */
  jawMax: number;
  /** Inner-lip gap at its widest; 0 when none has been measured. */
  mouthGapMax: number;
  /** Mouth-corner drop at the saddest measured pose; 0 when not measured. */
  mouthDropMax: number;
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
/**
 * Head turn, in the units the landmarks report, that reads as a full -1..1. A
 * real turn moves the nose by a few percent of the face width; the span is set
 * so an ordinary side-to-side turn reaches most of the eye's travel without
 * saturating on a small one.
 */
const HEAD_YAW_SPAN = 0.4;
/** The same for a nod, which travels a little less than a turn. */
const HEAD_PITCH_SPAN = 0.3;
/**
 * Eye-wide score above rest that reads as a fully bulged eye. The model reports
 * the widening directly; the split of a share of it (0..1) drives the iris and
 * pupil shrink.
 */
const EYE_WIDE_SPAN = 0.5;
/**
 * Aperture past the most open pose the calibration saw that counts as a full
 * bulge, in lid-gap ÷ eye-width units. The open reference is taken across the
 * gaze sweep, so it already allows for glancing widening the lid; only opening
 * beyond that fires.
 */
const WIDE_LID_SPAN = 0.1;
/**
 * Jaw span used before a wide-open pose has been measured. The calibration's
 * own range wins once it exists: speech is a share of how far this person can
 * open, so a fixed span either saturates their talking or leaves it invisible.
 */
const JAW_SPAN = 0.25;
/** Share of the span ignored at rest, so landmark wobble cannot move the lips. */
const JAW_REST_FLOOR = 0.06;
/**
 * Inner-lip gap, as a share of face width, used as a full opening before the
 * calibration has measured one. Teeth and mouthed speech part the lips without
 * dropping the jaw far, and the `jawOpen` score barely moves for them; this
 * second measure catches that.
 */
const MOUTH_GAP_SPAN = 0.2;
/** Smallest measured inner-lip range that is trusted, as a share of face width. */
const MOUTH_GAP_RANGE_MIN = 0.02;
/**
 * Mouth-corner drop, as a share of face width, used as a full frown before the
 * calibration has measured one. This is the geometric half of sadness: the
 * corners move down on the person's face even when the `mouthFrown` score barely
 * moves, which is what keeps the LipCorner covers working.
 */
const MOUTH_DROP_SPAN = 0.04;
/** Smallest measured corner-drop range that is trusted, as a share of face width. */
const MOUTH_DROP_RANGE_MIN = 0.01;
/**
 * Lip-rounding score above rest that reads as a fully narrowed mouth. The model
 * reports puckering and funneling separately from the smile and the frown,
 * which is what lets an "o" or "u" narrow the mouth even though neither corner
 * moves.
 */
const MOUTH_PUCKER_SPAN = 0.5;
/**
 * Mouth-corner midpoint travel that reads as a full side-to-side shift, as a
 * share of face width. A real jaw shift moves the corners by a few percent of
 * the face, so this makes a deliberate move obvious without saturating on
 * landmark wobble.
 */
const MOUTH_SHIFT_SPAN = 0.1;
/** The same for up and down, which travels less on a real face. */
const MOUTH_SHIFT_SPAN_Y = 0.08;
/**
 * Mouth twist that reads as a full pose, in radians (~17°) relative to the eye
 * line. Angles are already size-independent, so this needs no calibration.
 */
const MOUTH_TILT_SPAN = 0.3;
/**
 * Share of a simultaneous smile that can hide a frown. MediaPipe reports a
 * little mouthSmile on a sad face, and subtracting all of it left real sadness
 * with nothing to show.
 */
const SMILE_FROWN_CANCEL = 0.4;
/**
 * Share of a lowered brow that also pulls the mouth corners down. The calibrated
 * sad pose is brows down plus a frown; if the frown score stays weak, the brow
 * alone still has to reach the full sad cut, which is the `LipCorner` disc of the
 * Sadness references.
 */
const SAD_BROW_SHARE = 1;
/**
 * Smallest measured range that counts as movement. The calibration records how
 * far a signal actually travels on this person; anything flatter than this is
 * noise, and is ignored so a step that was skipped cannot invent a pose.
 */
const SCORE_RANGE_MIN = 0.08;
const LID_RANGE_MIN = 0.03;
/**
 * Shut endpoint used when the measured shut pose is too close to the open one.
 * A skipped step, or a neutral re-measured after the eyes run, can leave the
 * range flat; without this the eyelid would read zero for ever. A flat score
 * falls back on full closure, and a flat lid gap on a typical open-to-shut span.
 */
const SCORE_SHUT_FALLBACK = 1;
const LID_SHUT_FALLBACK = 0.1;
/**
 * Blendshape spans the mouth falls back on when its range was not measured, or
 * was too flat to use. Unlike the lids, a mouth channel stuck at zero reads as
 * a broken rig; a rough response is better than none, and the calibration still
 * refines it when a real range is found.
 */
const SMILE_SPAN = 0.8;
const FROWN_SPAN = 0.5;
/**
 * The eyebrow ridges, viewer left and right, as landmark indices. They are
 * averaged into one point per brow so a single jittery landmark cannot move it.
 * The subject's right brow is the viewer's left one.
 */
const BROW_RIDGE_LEFT = [70, 63, 105, 66, 107] as const;
const BROW_RIDGE_RIGHT = [336, 296, 334, 293, 300] as const;
/**
 * Brow span used when the sad pose did not lower the ridge measurably, in eye
 * widths. The brow is measured geometrically (below), so this is a distance on
 * the face, not a blendshape score: a real frown drops the ridge by about a
 * tenth of the eye's width.
 */
const BROW_LIFT_SPAN = 0.12;
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
  eyeWideLeft: 0,
  eyeWideRight: 0,
  lookH: 0,
  lookV: 0,
  smileLeft: 0,
  smileRight: 0,
  frownLeft: 0,
  frownRight: 0,
  jawOpen: 0,
  mouthGap: 0,
  mouthDrop: 0,
  mouthPucker: 0,
  // The mouth starts centred on the nose and level with the eyes; a measured
  // neutral replaces these, so a face that rests off-centre still reads zero.
  mouthX: 0,
  mouthY: 0,
  mouthTilt: 0,
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
  // 0 means "not measured": the mouth falls back to its fixed spans.
  jawMax: 0,
  mouthGapMax: 0,
  mouthDropMax: 0,
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

/** Mean of the points present, or null when there are none. */
function centroid(points: readonly (Landmark | undefined)[]): Landmark | null {
  let x = 0;
  let y = 0;
  let count = 0;
  for (const point of points) {
    if (point) {
      x += point.x;
      y += point.y;
      count += 1;
    }
  }
  return count > 0 ? { x: x / count, y: y / count } : null;
}

/**
 * Reads one frame's landmarks.
 *
 * The look has two parts, and a face needs both: the eyes in their sockets and
 * the direction the head itself points. Turning the head towards a screen corner
 * barely moves the pupils, so eye-only tracking follows the eyeball, not the
 * thing being looked at.
 *
 * The eye part is measured geometrically from the iris landmarks, in the eye's
 * own frame and from the eye's own corners. The corners are fixed to the skull,
 * so widening the lids moves neither the iris nor the reference: the pupil no
 * longer drifts on a bulge, which the `eyeLook*` scores did and so did an anchor
 * on the brow-driven bridge.
 *
 * The head direction is measured from the nose against the eye line: the nose
 * sits forward of the face plane, so it swings towards the side the head turns
 * to, and drops in the frame when the chin drops.
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
  // The eyebrow ridges, averaged over each brow. The brow moves with a frown but
  // not with a glance, and neither moves its eye's corners.
  const browLeft = centroid(BROW_RIDGE_LEFT.map((index) => landmarks[index]));
  const browRight = centroid(BROW_RIDGE_RIGHT.map((index) => landmarks[index]));
  // The middle of the eye line: the four eye corners averaged. The canthi are
  // fixed to the skull, so neither a widened lid nor a lifted brow can drag the
  // anchor the way they dragged the nose bridge — that drift is what pushed the
  // pupils down whenever the eyes bulged.
  const eyeMid = centroid([outerLeft, innerLeft, innerRight, outerRight]);
  const edgeLeft = landmarks[234];
  const edgeRight = landmarks[454];
  const lipUpper = landmarks[13];
  const lipLower = landmarks[14];
  const lipCornerLeft = landmarks[61];
  const lipCornerRight = landmarks[291];
  // Iris centres; the Tasks landmarker always adds these five points per eye.
  // The whole ring is averaged rather than trusting the single centre point:
  // the iris points jitter by a pixel, and this divides that by the ring size.
  const irisLeft = centroid([
    landmarks[468],
    landmarks[469],
    landmarks[470],
    landmarks[471],
    landmarks[472],
  ]);
  const irisRight = centroid([
    landmarks[473],
    landmarks[474],
    landmarks[475],
    landmarks[476],
    landmarks[477],
  ]);
  if (
    !outerLeft ||
    !innerLeft ||
    !innerRight ||
    !outerRight ||
    !nose ||
    !eyeMid ||
    !browLeft ||
    !browRight ||
    !edgeLeft ||
    !edgeRight ||
    !lipUpper ||
    !lipLower ||
    !lipCornerLeft ||
    !lipCornerRight
  ) {
    return null;
  }

  const eyeWidth = Math.max(1e-6, span(outerLeft, innerLeft, aspect));
  const eyeWidthRight = Math.max(1e-6, span(innerRight, outerRight, aspect));
  // The brow's height above that eye's own corner line, in eye widths. The
  // corners and the ridge are both fixed to the skull, so a glance or a blink
  // cannot lower the brow the way the `browDown` score did: that score also
  // answers to the upper lid, so looking up or down brought the lid nearer the
  // brow and the bands closed over the eyes.
  const browLiftLeft = browLift(browLeft, outerLeft, innerLeft, eyeWidth, aspect);
  const browLiftRight = browLift(browRight, innerRight, outerRight, eyeWidthRight, aspect);
  const score = new Map(shapes.map((shape) => [shape.categoryName ?? "", shape.score]));
  const value = (name: string) => score.get(name) ?? 0;

  // Face width, from the cheek edges: expression does not move them, and it is
  // only the scale the head turn is divided by.
  const faceWidth = Math.max(1e-6, Math.abs(edgeRight.x - edgeLeft.x));
  // Face width with the aspect applied, so the lip gap and the face share one
  // unit even on a non-square frame.
  const faceSpan = Math.max(1e-6, span(edgeLeft, edgeRight, aspect));

  // The mouth's own pose. The corners are the anchor: their midpoint moves with
  // the jaw but barely with the lips, so it measures where the mouth sits on
  // the face. Both angles are physical, so the frame's aspect is applied to the
  // horizontal span before `atan2`. Subtracting the eye line leaves the mouth's
  // own twist: a head roll turns both lines the same way and cancels.
  const lipTilt = Math.atan2(
    lipCornerRight.y - lipCornerLeft.y,
    Math.max(1e-6, Math.abs(lipCornerRight.x - lipCornerLeft.x) * aspect),
  );
  const eyeTilt = Math.atan2(
    outerRight.y - outerLeft.y,
    Math.max(1e-6, Math.abs(outerRight.x - outerLeft.x) * aspect),
  );

  // The eye-in-socket direction, from the iris against the eye's own corners.
  // The ends are given viewer-left to viewer-right, so `x` is positive towards
  // the viewer's right for both eyes, and the average over the pair cancels any
  // leftover rest bias. Missing iris points fall back to the blendshapes below.
  const byLeft = eyeLook(irisLeft, outerLeft, innerLeft, aspect);
  const byRight = eyeLook(irisRight, innerRight, outerRight, aspect);
  const byIris =
    byLeft && byRight
      ? { x: (byLeft.x + byRight.x) / 2, y: (byLeft.y + byRight.y) / 2 }
      : null;

  return {
    x: eyeMid.x,
    y: eyeMid.y,
    // Per half face width, so it does not shrink as the person moves away. The
    // eye line keeps a widening eye from faking a head turn.
    yaw: (nose.x - eyeMid.x) / (faceWidth / 2),
    pitch: (nose.y - eyeMid.y) / (faceWidth / 2),
    lidLeft: aperture(landmarks[159], landmarks[145], eyeWidth, aspect),
    lidRight: aperture(landmarks[386], landmarks[374], eyeWidthRight, aspect),
    // The viewer's left eye is the subject's right one.
    blinkLeft: value("eyeBlinkRight"),
    blinkRight: value("eyeBlinkLeft"),
    eyeWideLeft: value("eyeWideRight"),
    eyeWideRight: value("eyeWideLeft"),
    lookH:
      byIris?.x ??
      (value("eyeLookOutLeft") +
        value("eyeLookInRight") -
        value("eyeLookInLeft") -
        value("eyeLookOutRight")) /
        2,
    lookV:
      byIris?.y ??
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
    mouthGap: span(lipUpper, lipLower, aspect) / faceSpan,
    // Both corners dropping relative to the nose is the geometric frown. The
    // nose is the reference because a jaw drop moves neither it nor the
    // corners much, while the `mouthFrown` score can stay almost flat.
    mouthDrop: ((lipCornerLeft.y + lipCornerRight.y) / 2 - nose.y) / faceSpan,
    mouthPucker: Math.max(value("mouthPucker"), value("mouthFunnel")),
    mouthX: ((lipCornerLeft.x + lipCornerRight.x) / 2 - nose.x) / faceSpan,
    mouthY: ((lipCornerLeft.y + lipCornerRight.y) / 2 - nose.y) / faceSpan,
    mouthTilt: lipTilt - eyeTilt,
    // The cheek raise that comes with a real smile, per side.
    cheekSquintLeft: value("cheekSquintRight"),
    cheekSquintRight: value("cheekSquintLeft"),
    // Positive is the brow lowered towards the eye, in eye widths, measured
    // from the eye's own line; negative is a raised brow.
    browDownLeft: -browLiftLeft,
    browDownRight: -browLiftRight,
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
 * How high a brow sits above its eye's corner line, in eye widths.
 *
 * The line's middle is the reference: it is on the skull, like the brow, so the
 * number only changes when the brow itself moves. A head roll turns the vector
 * without changing its length, so it does not fake a frown either.
 */
function browLift(
  brow: Landmark,
  from: Landmark,
  to: Landmark,
  eyeWidth: number,
  aspect: number,
): number {
  const middle = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  return span(brow, middle, aspect) / eyeWidth;
}

/**
 * Where one iris sits, in eye widths, along the eye's own axis.
 *
 * `from` and `to` are the eye corners ordered viewer-left to viewer-right, so
 * `x` is positive towards the viewer's right for either eye. `y` is positive
 * above the corner line. The origin is the eye's own middle, so the offset is
 * the iris's place in its socket: a bulge moves the lids, not the corners or
 * the pupil. (Measuring from the bridge instead gave the horizontal offset a
 * long lever arm: the corner axis tilts a hair when the eye widens, and a
 * sideways look then leaked into the vertical one.) Working in the eye's frame
 * keeps a rolled head from turning a sideways look into a vertical one.
 */
function eyeLook(
  iris: Landmark | null | undefined,
  from: Landmark,
  to: Landmark,
  aspect: number,
): { x: number; y: number } | null {
  if (!iris) {
    return null;
  }

  const axisX = (to.x - from.x) * aspect;
  const axisY = to.y - from.y;
  const width = Math.hypot(axisX, axisY);
  if (!(width > 1e-6)) {
    return null;
  }
  const ux = axisX / width;
  const uy = axisY / width;

  const dx = (iris.x - (from.x + to.x) / 2) * aspect;
  const dy = iris.y - (from.y + to.y) / 2;

  return {
    x: (dx * ux + dy * uy) / width,
    y: (dx * uy - dy * ux) / width,
  };
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

/** One calibration look: the face's reading and the monitor point it aimed at. */
export interface GazeTracePoint {
  raw: RawSample;
  /** Cursor position, 0..1 across the monitor. */
  u: number;
  v: number;
}

/**
 * Fits the gaze map from the corner looks: least squares over both axes.
 *
 * The head and the eyes turn together when looking at a corner, which leaves
 * their two signals correlated. A little ridge on the normal equations keeps
 * the solve stable when one of them barely moved (a person who looks around with
 * their eyes alone), so the fit still learns the one that did.
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
  // fitted map already has that sign, learned from the corner looks.
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
    shutScore(openScoreLeft, calibration.shut.scoreLeft),
    SCORE_RANGE_MIN,
  );
  const scoreRight = ratio(
    raw.blinkRight,
    openScoreRight,
    shutScore(openScoreRight, calibration.shut.scoreRight),
    SCORE_RANGE_MIN,
  );

  // Mouth corners are measured per side, then combined for the mouth and the
  // cheeks. The smile widens the mouth; the frown grows the covers that hide the
  // smile corners. A smile can hide part of a simultaneously reported frown, and
  // a lowered brow pulls the corners down, so sadness still reads.
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
  // Rounded lips are their own shape: puckering or funneling narrows the mouth
  // without moving either corner, which is what an "o" or "u" looks like.
  const pucker = calibrated
    ? clamp((raw.mouthPucker - neutral.mouthPucker) / MOUTH_PUCKER_SPAN, 0, 1)
    : 0;
  // The geometric frown: the corners dropping below the upper lip. This is what
  // still reads as sadness when the `mouthFrown` blendshape barely moves.
  const measuredDrop = calibration.mouthDropMax - neutral.mouthDrop;
  const dropSpan =
    calibrated && measuredDrop >= MOUTH_DROP_RANGE_MIN ? measuredDrop : MOUTH_DROP_SPAN;
  const mouthDrop = calibrated
    ? clamp((raw.mouthDrop - neutral.mouthDrop) / dropSpan, 0, 1)
    : 0;

  // Where the mouth sits and how it is twisted, both relative to the pose held
  // during calibration. Positive x is to the right of the picture, the same
  // side the mouth actually moved to; positive y is down. Both are zero until a
  // neutral pose has been measured, because an unmeasured rest would drag the
  // mouth off its artwork.
  const mouthShiftX = calibrated
    ? clamp((raw.mouthX - neutral.mouthX) / MOUTH_SHIFT_SPAN, -1, 1)
    : 0;
  const mouthShiftY = calibrated
    ? clamp((raw.mouthY - neutral.mouthY) / MOUTH_SHIFT_SPAN_Y, -1, 1)
    : 0;
  const mouthTilt = calibrated
    ? clamp((raw.mouthTilt - neutral.mouthTilt) / MOUTH_TILT_SPAN, -1, 1)
    : 0;

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

  // Both opening measures are normalised against this person's own measured
  // wide-open pose. A fixed span cannot work: speech is a share of the range,
  // so a span smaller than that share saturates the mouth on every word.
  const measuredJaw = calibration.jawMax - neutral.jawOpen;
  const jawSpan = calibrated && measuredJaw >= SCORE_RANGE_MIN ? measuredJaw : JAW_SPAN;
  // `jawOpen` alone misses a smile that shows teeth and speech made with the
  // lips rather than the jaw: the inner-lip gap opens without the score moving.
  // The larger of the two openings drives the mouth. The gap is only trusted
  // once its resting value has been measured, because an unmeasured rest would
  // leave the mouth ajar.
  const measuredGap = calibration.mouthGapMax - neutral.mouthGap;
  const gapSpan =
    calibrated && measuredGap >= MOUTH_GAP_RANGE_MIN ? measuredGap : MOUTH_GAP_SPAN;
  const lipShare = calibrated ? (raw.mouthGap - neutral.mouthGap) / gapSpan : 0;
  const jaw = jawOpening(Math.max((raw.jawOpen - neutral.jawOpen) / jawSpan, lipShare));

  // Brow lowering, per side as seen by the viewer. A measured range too flat
  // to trust falls back to a fixed span, so a sad pose still lowers the brows
  // (and, through them, the mouth corners) instead of reading as zero.
  const browLeft = calibrated
    ? expressionRatio(raw.browDownLeft, neutral.browDownLeft, calibration.browMaxLeft, BROW_LIFT_SPAN)
    : 0;
  const browRight = calibrated
    ? expressionRatio(raw.browDownRight, neutral.browDownRight, calibration.browMaxRight, BROW_LIFT_SPAN)
    : 0;

  // A frown presses the upper lid down, so the gap and the blink score both
  // move a little without a blink. That share of the brow movement is taken
  // back below, so a frown does not read as half-closed eyes.
  const scoreLeftOpen = discountFrown(scoreLeft, browLeft, BROW_SCORE_LEAK);
  const scoreRightOpen = discountFrown(scoreRight, browRight, BROW_SCORE_LEAK);
  const lidLeftOpen = discountFrown(
    ratio(raw.lidLeft, openLidLeft, shutLid(openLidLeft, calibration.shut.lidLeft), LID_RANGE_MIN),
    browLeft,
    BROW_LID_LEAK,
  );
  const lidRightOpen = discountFrown(
    ratio(
      raw.lidRight,
      openLidRight,
      shutLid(openLidRight, calibration.shut.lidRight),
      LID_RANGE_MIN,
    ),
    browRight,
    BROW_LID_LEAK,
  );

  // A bulge is an eye opened past its own open reference (or the eye-wide score
  // rising above rest). The score and the aperture both read it, and the wider
  // of the two wins: either one can be flat on a face, and a bulge should still
  // shrink the iris. The score is kept apart as well, because the gaze hold uses
  // only that half: it is expression, not a passing glance upward.
  const wideScoreLeft = (raw.eyeWideLeft - neutral.eyeWideLeft) / EYE_WIDE_SPAN;
  const wideScoreRight = (raw.eyeWideRight - neutral.eyeWideRight) / EYE_WIDE_SPAN;
  const wideLeft = Math.max(
    wideScoreLeft,
    (raw.lidLeft - openLidLeft) / WIDE_LID_SPAN,
  );
  const wideRight = Math.max(
    wideScoreRight,
    (raw.lidRight - openLidRight) / WIDE_LID_SPAN,
  );

  return {
    x: calibrated ? clamp(-(raw.x - neutral.x) * HEAD_GAIN_X, -1, 1) : 0,
    y: calibrated ? clamp((raw.y - neutral.y) * HEAD_GAIN_Y, -1, 1) : 0,
    // The head's own turn, independent of the gaze fit and of where the pupils
    // point. Positive is the side of the picture the head turned towards, and
    // down for a dropped chin, which is the rig's own convention.
    headYaw: calibrated ? clamp((raw.yaw - neutral.yaw) / HEAD_YAW_SPAN, -1, 1) : 0,
    headPitch: calibrated ? clamp((raw.pitch - neutral.pitch) / HEAD_PITCH_SPAN, -1, 1) : 0,
    blinkLeft: calibrated ? closure(scoreLeftOpen, lidLeftOpen, scoreRightOpen) : 0,
    blinkRight: calibrated ? closure(scoreRightOpen, lidRightOpen, scoreLeftOpen) : 0,
    eyeWide: calibrated ? clamp(Math.max(wideLeft, wideRight), 0, 1) : 0,
    eyeWideScore: calibrated ? clamp(Math.max(wideScoreLeft, wideScoreRight), 0, 1) : 0,
    lookX: clamp(gaze.u * 2 - 1, -1, 1),
    lookY: clamp(gaze.v * 2 - 1, -1, 1),
    cheekLeft,
    cheekRight,
    browLeft,
    browRight,
    mouthOpen: jaw,
    mouthWidth: smile,
    mouthPucker: pucker,
    mouthShiftX,
    mouthShiftY,
    mouthTilt,
    mouthBottomWidth: Math.max(smile, jaw),
    mouthHappyLeft: smileLeft,
    mouthHappyRight: smileRight,
    mouthSadLeft: Math.max(
      0,
      frownLeft - smileLeft * SMILE_FROWN_CANCEL,
      browLeft * SAD_BROW_SHARE,
      mouthDrop,
    ),
    mouthSadRight: Math.max(
      0,
      frownRight - smileRight * SMILE_FROWN_CANCEL,
      browRight * SAD_BROW_SHARE,
      mouthDrop,
    ),
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
 * The opening channel for a share of its measured range, 0..1.
 *
 * The rest floor keeps a shut mouth shut through landmark noise. Past it the
 * share maps straight through: the rig's own ease-out already turns the pose
 * into a lip that starts moving with the first travel, so speech at half of a
 * full opening reads as half open rather than fully open.
 */
function jawOpening(share: number): number {
  const value = clamp(share, 0, 1);
  if (value <= JAW_REST_FLOOR) {
    return 0;
  }
  return (value - JAW_REST_FLOOR) / (1 - JAW_REST_FLOOR);
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
 * The shut endpoint for a blink score, falling back when the measured range is
 * too flat to use (a skipped pose, or a neutral re-measured at a different lid
 * position). Without it, one eyelid can silently never close.
 */
function shutScore(open: number, shut: number): number {
  return shut - open >= SCORE_RANGE_MIN ? shut : SCORE_SHUT_FALLBACK;
}

/**
 * The shut endpoint for a lid gap. The open reference is the narrower of the
 * neutral and the gaze sweep, so a re-measured neutral can leave the measured
 * shut above it; a typical open-to-shut span is used instead.
 */
function shutLid(open: number, shut: number): number {
  return open - shut >= LID_RANGE_MIN ? shut : Math.max(0, open - LID_SHUT_FALLBACK);
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
 * The corner looks are a handful of holds, and the person may blink during
 * them. A percentile reads the edge of the open-eye range without letting a
 * stray blink (high score, low gap) set it.
 */
export function percentileOf(values: number[], quantile: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.round(clamp(quantile, 0, 1) * (sorted.length - 1));
  return sorted[index];
}
