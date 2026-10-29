import { SCREEN_CENTRE, fromOrigin, type ScreenPoint } from "../anchor";
import { MOUTH } from "./art";
import type { FaceRig } from "./rig";
import type { FaceSample } from "./tracker";

/**
 * Applies a tracked face to the rig.
 *
 * The tracker runs at about 15 Hz while the face renders at 30, so every pose
 * value is smoothed here on every frame instead of being written straight through.
 * A sample older than `STALE_MS` (camera stalled, or the face left the frame)
 * settles back to a neutral face rather than freezing the last expression.
 *
 * Landmarks wobble by a pixel or two on a still face, and every wobble is
 * amplified by the gaze and head gains; written straight through, the whole face
 * shivers. Each value therefore goes through a dead zone (small readings are
 * noise and move nothing) and a One Euro filter (heavy smoothing at rest, light
 * smoothing while genuinely moving), so the face is still when the person is
 * still without trailing a deliberate move.
 */

/** How long the last sample stays usable. */
const STALE_MS = 400;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/**
 * Reading smaller than this is treated as noise, in the -1..1 rig units.
 * The first is head lean, which the eyes amplify; the gaze itself stays light
 * enough to answer a real glance.
 */
const HEAD_DEAD = 0.045;
/**
 * Head turn is read from the nose, which is steadier than the head's place in
 * the frame, but it is a difference of two landmarks and needs a wider floor.
 */
const HEAD_TURN_DEAD = 0.07;
const GAZE_DEAD = 0.04;
const EXPRESSION_DEAD = 0.06;
const BLINK_DEAD = 0.06;
/** The lid gap is small, so its noise is amplified when it drives the eye size. */
const EYE_WIDE_DEAD = 0.1;
/**
 * The eye-wide blendshape above which the gaze and head lean hold still, and the
 * lower value that lets them follow again. A wide-eyed expression distorts the
 * landmarks the gaze is measured from; the hold keeps the pupils pointing where
 * they were while the iris size still answers the bulge.
 */
const BULGE_HOLD_ON = 0.45;
const BULGE_HOLD_OFF = 0.2;
/** Score wobble ignored when deciding whether to hold. */
const BULGE_SCORE_DEAD = 0.05;
/** The jaw has no range dead zone of its own, so only real noise is dropped. */
const MOUTH_DEAD = 0.01;
/**
 * Mouth place and twist are small, slow movements; a larger dead zone keeps the
 * whole mouth from trembling on a still face, while a deliberate shift still
 * clears it. The filter then follows the move without lagging behind it.
 */
const MOUTH_POSE_DEAD = 0.08;

/**
 * The tracked signals read 0 at rest; the rig's mouth starts at `MOUTH.rest`.
 * Every channel therefore travels from that rest pose to 1, so a relaxed face
 * keeps the mouth the artwork draws and a full pose reaches the reference
 * extreme. Corners are signed: the rest pose is slightly upturned, a smile
 * takes them to 1 and a frown all the way to -1.
 */
const CORNER_RANGE = 1 - MOUTH.rest.corner;
/** A frown travels from the rest corner all the way to the full sad cut. */
const SAD_RANGE = 1 + MOUTH.rest.corner;

/** One Euro filter settings: steady cutoff, speed boost, speed smoothing. */
interface FilterOptions {
  /** Cutoff in Hz while the signal is still; lower is steadier. */
  minCutoff: number;
  /** Cutoff added per unit of speed, so a fast move is not dragged behind. */
  beta: number;
  /** Cutoff of the speed estimate itself, in Hz. */
  derivativeCutoff: number;
}

/** Slower at rest than the old fixed easings, and closer to them under motion. */
const HEAD_FILTER: FilterOptions = { minCutoff: 0.7, beta: 1.2, derivativeCutoff: 0.8 };
/**
 * The camera-mode look is measured from the iris, which is a pixel-accurate but
 * jittery landmark, and the fitted map amplifies it. This filter is therefore
 * steadier than the manual gaze one, with a low speed boost so the jitter does
 * not wake it up.
 */
const GAZE_FILTER: FilterOptions = { minCutoff: 0.6, beta: 0.8, derivativeCutoff: 0.7 };
const EXPRESSION_FILTER: FilterOptions = { minCutoff: 0.9, beta: 1.2, derivativeCutoff: 1 };
/** The lid gap is small; a slower filter keeps the iris and pupil size still. */
const EYE_WIDE_FILTER: FilterOptions = { minCutoff: 0.6, beta: 0.6, derivativeCutoff: 1 };
/** The hold must engage as the bulge appears, so this gate is quick. */
const BULGE_FILTER: FilterOptions = { minCutoff: 2.5, beta: 3, derivativeCutoff: 2 };
/** Speech moves the jaw quickly, so it gets a faster filter than the expressions. */
const JAW_FILTER: FilterOptions = { minCutoff: 3, beta: 4, derivativeCutoff: 2 };
/** How much of the lid motion the brows and cheeks take, per eye. */
const BLINK_BROW = 0.25;
const BLINK_CHEEK = 0.2;
/** How much of a raised cheek stretches its band towards the eye. */
const CHEEK_CLOSE = 0.45;
/**
 * How far a frown may stretch the brow bands in camera mode. The rig's full
 * range carries a band right across the eye — the manual keys' job — but a
 * frown should lower the band, not hide the eye, so tracking stops halfway.
 */
const TRACKED_BROW_RANGE = 0.5;

/**
 * Closure from which a blink counts as a real blink. At 15 fps the peak frame
 * often lands halfway through, and the model's score drops again before the lids
 * are back up; snapping to a full blink keeps the face from doing a twitch.
 */
export const BLINK_SNAP = 0.7;
/** How long the lids stay shut after the reading starts opening. */
export const BLINK_HOLD = 0.11;
/** Closing is quick; opening is slower, so a blink reads as a blink. */
export const BLINK_CLOSE_TAU = 0.05;
export const BLINK_OPEN_TAU = 0.2;

/** Per-eye blink state carried between frames. */
export interface BlinkState {
  /** Current closure, 0..1. */
  value: number;
  /** Seconds left of the shut hold. */
  hold: number;
}

export function blinkState(): BlinkState {
  return { value: 0, hold: 0 };
}

/**
 * Advances one eyelid towards `target`.
 *
 * A target past `BLINK_SNAP` is treated as a blink and taken all the way shut.
 * Once the reading starts falling the pose holds for `BLINK_HOLD`, then eases
 * open over `BLINK_OPEN_TAU`; that minimum shut time is what keeps the face's
 * eyes closed for as long as the person's, instead of opening on the first
 * frame that reports a gap.
 */
export function stepBlink(state: BlinkState, target: number, dt: number): void {
  const aim = target >= BLINK_SNAP ? 1 : target;

  if (aim >= state.value) {
    // Only a real rise arms the hold; otherwise noise around a slowly opening
    // lid would keep re-arming it and the lid would stutter on the way up.
    const rising = aim - state.value > 0.05;
    state.value += (aim - state.value) * (1 - Math.exp(-dt / BLINK_CLOSE_TAU));
    if (rising || aim >= BLINK_SNAP) {
      state.hold = BLINK_HOLD;
    }
    return;
  }

  if (state.hold > 0) {
    state.hold = Math.max(0, state.hold - dt);
    return;
  }

  state.value += (target - state.value) * (1 - Math.exp(-dt / BLINK_OPEN_TAU));
}

/**
 * Squeezes a small reading to zero and the rest back into the same range.
 *
 * Below `width` nothing moves at all, which is what keeps a still face still;
 * above it the value is shifted down and stretched, so a real movement of 1
 * still reaches 1. Continuous, so there is no snapping at the edge.
 */
export function deadZone(value: number, width: number): number {
  const edge = Math.min(Math.max(width, 0), 0.999);
  const magnitude = Math.abs(value);
  if (magnitude <= edge) {
    return 0;
  }
  return Math.sign(value) * ((magnitude - edge) / (1 - edge));
}

/**
 * One Euro filter: a low-pass whose cutoff follows how fast the reading moves.
 *
 * A fixed time constant has to choose between a shaky face when still and a
 * laggy one when moving. Here the cutoff sits at `minCutoff` while the signal is
 * nearly still and rises by `beta` for every unit of speed, so a deliberate
 * movement is followed almost immediately while resting noise is smoothed away.
 */
export class PoseFilter {
  #value = 0;
  #previous = 0;
  #speed = 0;
  #started = false;

  constructor(private readonly options: FilterOptions) {}

  /** Current smoothed value. */
  get value(): number {
    return this.#value;
  }

  /** Drops the history and starts from `value`. */
  reset(value = 0): void {
    this.#value = value;
    this.#previous = value;
    this.#speed = 0;
    this.#started = true;
  }

  filter(target: number, dt: number): number {
    if (!(dt > 0)) {
      return this.#value;
    }
    if (!this.#started) {
      this.reset(target);
      return target;
    }

    // Speed of the raw reading, itself smoothed, so one noisy frame cannot
    // wake the filter up.
    const change = (target - this.#previous) / dt;
    this.#speed += (change - this.#speed) * responsiveness(this.options.derivativeCutoff, dt);
    this.#previous = target;

    const cutoff = this.options.minCutoff + this.options.beta * Math.abs(this.#speed);
    this.#value += (target - this.#value) * responsiveness(cutoff, dt);
    return this.#value;
  }
}

/** Share of the way to the target the filter covers over `dt` at `cutoff` Hz. */
function responsiveness(cutoff: number, dt: number): number {
  return 1 - Math.exp(-2 * Math.PI * cutoff * dt);
}

const NEUTRAL: FaceSample = {
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
};

export class FaceTracking {
  #target: FaceSample | null = null;
  #targetAt = 0;
  #pose: FaceSample = { ...NEUTRAL };
  #left = blinkState();
  #right = blinkState();
  /** True while a bulge holds the gaze and head lean in place. */
  #bulgeHold = false;
  #filters = {
    x: new PoseFilter(HEAD_FILTER),
    y: new PoseFilter(HEAD_FILTER),
    headYaw: new PoseFilter(HEAD_FILTER),
    headPitch: new PoseFilter(HEAD_FILTER),
    eyeWide: new PoseFilter(EYE_WIDE_FILTER),
    eyeWideScore: new PoseFilter(BULGE_FILTER),
    lookX: new PoseFilter(GAZE_FILTER),
    lookY: new PoseFilter(GAZE_FILTER),
    cheekLeft: new PoseFilter(EXPRESSION_FILTER),
    cheekRight: new PoseFilter(EXPRESSION_FILTER),
    browLeft: new PoseFilter(EXPRESSION_FILTER),
    browRight: new PoseFilter(EXPRESSION_FILTER),
    mouthOpen: new PoseFilter(JAW_FILTER),
    mouthWidth: new PoseFilter(EXPRESSION_FILTER),
    mouthPucker: new PoseFilter(EXPRESSION_FILTER),
    mouthShiftX: new PoseFilter(EXPRESSION_FILTER),
    mouthShiftY: new PoseFilter(EXPRESSION_FILTER),
    mouthTilt: new PoseFilter(EXPRESSION_FILTER),
    mouthBottomWidth: new PoseFilter(JAW_FILTER),
    mouthHappyLeft: new PoseFilter(EXPRESSION_FILTER),
    mouthHappyRight: new PoseFilter(EXPRESSION_FILTER),
    mouthSadLeft: new PoseFilter(EXPRESSION_FILTER),
    mouthSadRight: new PoseFilter(EXPRESSION_FILTER),
  };

  /** The newest reading; null when the model saw no face. */
  set(sample: FaceSample | null): void {
    this.#target = sample;
    this.#targetAt = performance.now();
  }

  /** The eased pose last written to the rig, for readouts that mirror it. */
  get pose(): Readonly<FaceSample> {
    return this.#pose;
  }

  /** Advances the smoothing and writes the pose to the rig. */
  update(rig: FaceRig, dt: number, origin: ScreenPoint = SCREEN_CENTRE): void {
    const now = performance.now();
    const live = this.#target && now - this.#targetAt <= STALE_MS ? this.#target : NEUTRAL;
    const seconds = Math.max(dt, 0);
    const filters = this.#filters;

    // A wide-eyed expression moves the landmarks the gaze and the head lean are
    // measured from. While the eye-wide blendshape is high, those channels hold
    // the last good value: a bulge changes the iris size, not the direction.
    this.#pose.eyeWideScore = filters.eyeWideScore.filter(
      deadZone(live.eyeWideScore, BULGE_SCORE_DEAD),
      seconds,
    );
    if (this.#pose.eyeWideScore > BULGE_HOLD_ON) {
      this.#bulgeHold = true;
    } else if (this.#pose.eyeWideScore < BULGE_HOLD_OFF) {
      this.#bulgeHold = false;
    }

    if (!this.#bulgeHold) {
      this.#pose.x = filters.x.filter(deadZone(live.x, HEAD_DEAD), seconds);
      this.#pose.y = filters.y.filter(deadZone(live.y, HEAD_DEAD), seconds);
      this.#pose.headYaw = filters.headYaw.filter(deadZone(live.headYaw, HEAD_TURN_DEAD), seconds);
      this.#pose.headPitch = filters.headPitch.filter(
        deadZone(live.headPitch, HEAD_TURN_DEAD),
        seconds,
      );
      this.#pose.lookX = filters.lookX.filter(deadZone(live.lookX, GAZE_DEAD), seconds);
      this.#pose.lookY = filters.lookY.filter(deadZone(live.lookY, GAZE_DEAD), seconds);
    }
    this.#pose.cheekLeft = filters.cheekLeft.filter(
      deadZone(live.cheekLeft, EXPRESSION_DEAD),
      seconds,
    );
    this.#pose.cheekRight = filters.cheekRight.filter(
      deadZone(live.cheekRight, EXPRESSION_DEAD),
      seconds,
    );
    this.#pose.browLeft = filters.browLeft.filter(deadZone(live.browLeft, EXPRESSION_DEAD), seconds);
    this.#pose.browRight = filters.browRight.filter(
      deadZone(live.browRight, EXPRESSION_DEAD),
      seconds,
    );
    this.#pose.mouthOpen = filters.mouthOpen.filter(deadZone(live.mouthOpen, MOUTH_DEAD), seconds);
    this.#pose.mouthWidth = filters.mouthWidth.filter(
      deadZone(live.mouthWidth, EXPRESSION_DEAD),
      seconds,
    );
    this.#pose.mouthPucker = filters.mouthPucker.filter(
      deadZone(live.mouthPucker, EXPRESSION_DEAD),
      seconds,
    );
    this.#pose.mouthShiftX = filters.mouthShiftX.filter(
      deadZone(live.mouthShiftX, MOUTH_POSE_DEAD),
      seconds,
    );
    this.#pose.mouthShiftY = filters.mouthShiftY.filter(
      deadZone(live.mouthShiftY, MOUTH_POSE_DEAD),
      seconds,
    );
    this.#pose.mouthTilt = filters.mouthTilt.filter(
      deadZone(live.mouthTilt, MOUTH_POSE_DEAD),
      seconds,
    );
    this.#pose.mouthBottomWidth = filters.mouthBottomWidth.filter(
      deadZone(live.mouthBottomWidth, MOUTH_DEAD),
      seconds,
    );
    this.#pose.mouthHappyLeft = filters.mouthHappyLeft.filter(
      deadZone(live.mouthHappyLeft, EXPRESSION_DEAD),
      seconds,
    );
    this.#pose.mouthHappyRight = filters.mouthHappyRight.filter(
      deadZone(live.mouthHappyRight, EXPRESSION_DEAD),
      seconds,
    );
    this.#pose.mouthSadLeft = filters.mouthSadLeft.filter(
      deadZone(live.mouthSadLeft, EXPRESSION_DEAD),
      seconds,
    );
    this.#pose.mouthSadRight = filters.mouthSadRight.filter(
      deadZone(live.mouthSadRight, EXPRESSION_DEAD),
      seconds,
    );

    // The lid shaper has its own snap and hold; a dead zone keeps the small
    // wobble in the blink score from trembling the lids on the way.
    stepBlink(this.#left, deadZone(live.blinkLeft, BLINK_DEAD), seconds);
    stepBlink(this.#right, deadZone(live.blinkRight, BLINK_DEAD), seconds);
    this.#pose.blinkLeft = this.#left.value;
    this.#pose.blinkRight = this.#right.value;
    this.#pose.eyeWide = filters.eyeWide.filter(deadZone(live.eyeWide, EYE_WIDE_DEAD), seconds);

    const { blinkLeft, blinkRight, cheekLeft, cheekRight, browLeft, browRight } = this.#pose;
    const { x, y, headYaw, headPitch, lookX, lookY } = this.#pose;
    // The tracked gaze is already in monitor terms, so the corner origin does
    // the same thing it does to the cursor: it moves where the face stands, not
    // where it is looking.
    const look = fromOrigin({ u: 0.5 + lookX / 2, v: 0.5 + lookY / 2 }, origin);
    rig.setHead(x, y, headYaw, headPitch);
    rig.setTrackedLook(look.u * 2 - 1, look.v * 2 - 1);
    rig.setEyeClose(blinkLeft, "left");
    rig.setEyeClose(blinkRight, "right");
    // A bulge shrinks the iris and thins the pupil on top of the manual sizes.
    rig.setEyeWide(this.#pose.eyeWide);
    // A blink drags the brows down a little, and lowering the brows does the
    // rest; a raised cheek stretches its band and lifts its outer end.
    rig.setBrowClose(clamp01(blinkLeft * BLINK_BROW + browLeft * TRACKED_BROW_RANGE), "left");
    rig.setBrowClose(clamp01(blinkRight * BLINK_BROW + browRight * TRACKED_BROW_RANGE), "right");
    rig.setCheekClose(clamp01(blinkLeft * BLINK_CHEEK + cheekLeft * CHEEK_CLOSE), "left");
    rig.setCheekClose(clamp01(blinkRight * BLINK_CHEEK + cheekRight * CHEEK_CLOSE), "right");
    rig.setCheekLift((cheekLeft + cheekRight) / 2);

    // The tracker reads the mouth from 0 at rest; every channel travels from
    // the rest pose in both directions. A smile widens towards the Max width,
    // while a frown or rounded lips ("o"/"u") narrow towards the Min one.
    const rest = MOUTH.rest;
    rig.setMouthOpen(rest.open + (1 - rest.open) * this.#pose.mouthOpen);
    const sad = Math.max(this.#pose.mouthSadLeft, this.#pose.mouthSadRight);
    const narrow = Math.max(sad, this.#pose.mouthPucker);
    const stretch = this.#pose.mouthWidth - narrow;
    rig.setMouthWidth(
      stretch >= 0
        ? rest.width + (1 - rest.width) * stretch
        : rest.width * (1 + stretch),
    );
    rig.setMouthBottomWidth(
      rest.bottomWidth + (1 - rest.bottomWidth) * this.#pose.mouthBottomWidth,
    );
    rig.setMouthCorner("left", this.#cornerOf(this.#pose.mouthHappyLeft, this.#pose.mouthSadLeft));
    rig.setMouthCorner(
      "right",
      this.#cornerOf(this.#pose.mouthHappyRight, this.#pose.mouthSadRight),
    );
    // The mouth travels and twists as a whole, around its own centre: a move is
    // a translation of the lips together, not a swing from the middle of the
    // face, so the corners never angle towards the nose.
    rig.setMouthPose(this.#pose.mouthShiftX, this.#pose.mouthShiftY, this.#pose.mouthTilt);
  }

  /** A smile lifts a corner, a frown cuts it down, both from the rest pose. */
  #cornerOf(happy: number, sad: number): number {
    return Math.min(1, Math.max(-1, MOUTH.rest.corner + CORNER_RANGE * happy - SAD_RANGE * sad));
  }

  /** Drops back to a shut, centred face and writes it once. */
  reset(rig: FaceRig): void {
    this.#target = null;
    this.#pose = { ...NEUTRAL };
    this.#left = blinkState();
    this.#right = blinkState();
    this.#bulgeHold = false;
    for (const filter of Object.values(this.#filters)) {
      filter.reset();
    }
    rig.setHead(0, 0);
    rig.setLook(0, 0);
    rig.setEyeClose(0);
    rig.setEyeWide(0);
    rig.setBrowClose(0);
    rig.setCheekClose(0);
    rig.setCheekLift(0);
    rig.resetMouth();
  }
}
