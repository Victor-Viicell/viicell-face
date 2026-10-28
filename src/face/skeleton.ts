/**
 * The face skeleton.
 *
 * Every bone is a transform node placed at its pivot in artboard units
 * (1920×1080, origin top-left). Rotating or scaling a bone happens around that
 * pivot, so the pivots are the joints of the rig:
 *
 * - eye bones pivot at the centre of the iris (the eye "looks" from there),
 * - brow and cheek bones pivot at their inner end, next to the nose,
 * - the mouth pivots at its centre for width, and the lower lip at its top edge
 *   so opening it grows downward behind the upper lip,
 * - the synth line pivots at the bottom edge of the artboard,
 * - the face bone pivots at the middle of the artboard.
 *
 * The order of this list is the render order between siblings.
 */

export type BoneId =
  | "face"
  | "eyeLeft"
  | "eyeLeftShell"
  | "eyeLeftIris"
  | "eyeLeftPupil"
  | "eyeRight"
  | "eyeRightShell"
  | "eyeRightIris"
  | "eyeRightPupil"
  | "cheekLeft"
  | "cheekRight"
  | "browLeft"
  | "browRight"
  | "mouth"
  | "mouthBottom"
  | "mouthTop"
  | "mouthGap"
  | "mouthCornerLeft"
  | "mouthCornerRight"
  | "synth";

export interface BoneDef {
  id: BoneId;
  parent: BoneId | null;
  /** Rotation/scale origin, in artboard units. */
  pivot: readonly [number, number];
}

/** Centre of both irises: the eye opens, blinks and looks around from here. */
const EYE_LEFT = [523.542, 412.083] as const;
const EYE_RIGHT = [1396.458, 412.083] as const;

/** Inner ends of the slash shapes, closest to the middle of the face. */
const BROW_LEFT = [759.443, 155.282] as const;
const BROW_RIGHT = [1160.557, 155.282] as const;
const CHEEK_LEFT = [759.443, 680.174] as const;
const CHEEK_RIGHT = [1160.557, 680.174] as const;

export const BONES: readonly BoneDef[] = [
  { id: "face", parent: null, pivot: [960, 540] },

  // Left eye: the assembly carries the shell and the iris, so scaling it
  // squashes the whole eye (blink) while the iris keeps its own transform.
  { id: "eyeLeft", parent: "face", pivot: EYE_LEFT },
  { id: "eyeLeftShell", parent: "eyeLeft", pivot: EYE_LEFT },
  { id: "eyeLeftIris", parent: "eyeLeft", pivot: EYE_LEFT },
  { id: "eyeLeftPupil", parent: "eyeLeftIris", pivot: EYE_LEFT },

  { id: "eyeRight", parent: "face", pivot: EYE_RIGHT },
  { id: "eyeRightShell", parent: "eyeRight", pivot: EYE_RIGHT },
  { id: "eyeRightIris", parent: "eyeRight", pivot: EYE_RIGHT },
  { id: "eyeRightPupil", parent: "eyeRightIris", pivot: EYE_RIGHT },

  { id: "cheekLeft", parent: "face", pivot: CHEEK_LEFT },
  { id: "cheekRight", parent: "face", pivot: CHEEK_RIGHT },
  { id: "browLeft", parent: "face", pivot: BROW_LEFT },
  { id: "browRight", parent: "face", pivot: BROW_RIGHT },

  // The mouth is a small rig of its own. The root scales the whole mouth for
  // width, the lower lip opens and widens on its own, and the upper line sits
  // on top. The gap bone owns the dark cut between the lips, and each corner
  // bone owns the cut that turns that end of the smile from happy to sad. The
  // synth line is independent, on the bottom edge of the artboard.
  { id: "mouth", parent: "face", pivot: [960, 760] },
  { id: "mouthBottom", parent: "mouth", pivot: [960, 501.102] },
  { id: "mouthTop", parent: "mouth", pivot: [960, 760] },
  { id: "mouthGap", parent: "mouth", pivot: [960, 760] },
  // Pivots are the centres of the corner cuts at the widest reference mouth.
  { id: "mouthCornerLeft", parent: "mouth", pivot: [706.903, 674.3] },
  { id: "mouthCornerRight", parent: "mouth", pivot: [1213.097, 674.3] },
  { id: "synth", parent: "face", pivot: [960, 1080] },
];
