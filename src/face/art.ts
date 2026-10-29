/**
 * Artwork of the face, lifted from `viicell-faces.svg` (viewBox 1920×1080).
 *
 * The paths are inlined instead of loading the SVG as one texture: a flat image
 * cannot be posed, and the rig needs every piece as its own display object.
 * Each entry names the bone that owns it (see `skeleton.ts`), so shapes are
 * placed on the skeleton rather than drawn at fixed coordinates.
 */

import { FACE } from "./palette";
import { linear, radial, type Paint } from "./paint";
import type { BoneId } from "./skeleton";

export const ARTBOARD = { width: 1920, height: 1080 } as const;

/**
 * Paints for the artwork's three source classes, now with range.
 *
 * Every gradient is in shape-local space (see `paint.ts`), so the same paint
 * works on both mirrored halves without knowing where they sit.
 */
export const PAINT = {
  shell: linear({ x: 0, y: 0 }, { x: 0.18, y: 1 }, [
    { offset: 0, color: FACE.shell.top },
    { offset: 0.45, color: FACE.shell.middle },
    { offset: 1, color: FACE.shell.bottom },
  ]),
  iris: radial(0.5, [
    { offset: 0, color: FACE.iris.inner },
    { offset: 0.55, color: FACE.iris.middle },
    { offset: 1, color: FACE.iris.outer },
  ]),
  pupil: linear({ x: 0, y: 0 }, { x: 0, y: 1 }, [
    { offset: 0, color: FACE.pupil.top },
    { offset: 0.5, color: FACE.pupil.middle },
    { offset: 1, color: FACE.pupil.bottom },
  ]),
  line: linear({ x: 0, y: 0 }, { x: 0, y: 1 }, [
    { offset: 0, color: FACE.line.top },
    { offset: 1, color: FACE.line.bottom },
  ]),
  /** The resting mouth band, read left to right. */
  plinth: linear({ x: 0, y: 0.5 }, { x: 1, y: 0.5 }, [
    { offset: 0, color: FACE.mouth.left },
    { offset: 0.5, color: FACE.mouth.middle },
    { offset: 1, color: FACE.mouth.right },
  ]),
  /** A spectrum rod, from its lit tip down to the band. */
  rod: linear({ x: 0, y: 0 }, { x: 0, y: 1 }, [
    { offset: 0, color: FACE.mouth.tip },
    { offset: 0.35, color: FACE.mouth.middle },
    { offset: 1, color: FACE.mouth.base },
  ]),
} satisfies Record<string, Paint>;

/**
 * The "synth line": a thin band across the bottom edge of the artboard with a
 * row of rods above it (see `mouth.ts`). The measurements come from the artwork
 * so silence reproduces its resting bars exactly; the microphone drives the
 * rods up from there.
 */
export const SYNTH = {
  left: 0,
  right: ARTBOARD.width,
  /** Vertical centre of the band. */
  baseline: 1075.534,
  /** Thickness of the band. */
  thickness: 8.932,
  /** Number of rods drawn across the line. */
  rods: 114,
  /** Width of one rod. */
  rodWidth: 8.932,
  /** Distance between the left edges of neighbouring rods. */
  pitch: 16.8303,
  /** Height of a rod at rest, measured from the top of the band. */
  rest: 1071.068 - 1023.867,
} as const;

/**
 * The mouth rig's reference pose. These paths are the **widest and most open**
 * mouth from the supplied reference set; the pose helpers scale them back
 * towards the narrow/closed reference. At the corners of the parameter space
 * the transforms reproduce every reference SVG exactly:
 *
 * - width scales the whole mouth X by 0.5..1 (the narrow reference is half the
 *   wide one),
 * - open scales the lower lip Y about its top edge by 0.454..1,
 * - bottom width scales the lower lip X by 0.692..1.608 on top of the width,
 * - the corner value moves each corner cut from no cut (happiest) through the
 *   flat sliver of the Happiness references to the full disc of the Sadness
 *   references, which hides the upturned end of the smile.
 *
 * The reference files are `Max*Width.svg` / `Min*Width.svg` in the project root.
 */
export const MOUTH = {
  top: "M959.337 657.673 C986.46 634.46 1037.815 618.8 1096.703 618.8 C1183.869 618.8 1254.53 653.112 1254.53 695.438 C1254.53 717.981 1234.486 738.251 1202.579 752.275 L1182.986 816.025 L1167.018 764.07 C1145.845 769.194 1121.967 772.077 1096.703 772.077 C1038.761 772.077 988.112 756.915 960.663 734.316 C933.54 757.529 882.185 773.189 823.297 773.189 C797.906 773.189 773.915 770.278 752.664 765.105 L737.014 816.025 L717.816 753.56 C685.68 739.531 665.47 719.187 665.47 696.551 C665.47 654.224 736.131 619.912 823.297 619.912 C881.239 619.912 931.888 635.074 959.337 657.673 Z",
  bottom: "M776.9 757.948 C776.9 616.096 858.877 501.102 960 501.102 C1061.123 501.102 1143.1 616.096 1143.1 757.948 C1143.1 899.8 1061.123 1014.794 960 1014.794 C858.877 1014.794 776.9 899.8 776.9 757.948 Z",
  /** The dark gap between the lips, cut out of the mouth at the widest pose. */
  cutout: "M730.307 596.311 L730.307 268.174 L1189.693 268.174 L1189.693 594.964 C1228.996 611.845 1254.53 639.15 1254.53 669.963 C1254.53 698.533 1232.578 724.087 1198.052 741.112 L1182.986 790.132 L1171.206 751.803 C1149.015 758.803 1123.648 762.774 1096.703 762.774 C1041.47 762.774 992.863 746.089 964.663 720.823 L956.813 720.823 C928.852 746.841 879.506 764.121 823.297 764.121 C796.2 764.121 770.697 760.105 748.417 753.03 L737.014 790.132 L722.436 742.699 C687.629 725.675 665.47 700.014 665.47 671.31 C665.47 640.498 691.004 613.192 730.307 596.311 Z",

  /** Whole-mouth X scale, from the narrow reference to the wide one. */
  width: { min: 0.5, max: 1 },
  /** Lower lip Y scale about its top edge, from the closed reference to this one. */
  open: { min: 1 / 2.2026, max: 1 },
  /** Lower lip X scale on top of the width, from the narrow lip to the wide one. */
  bottomWidth: { min: 0.692, max: 1.609 },

  /**
   * Corner cuts, from the `LipCorner` group of the Happiness/Sadness references.
   * Each cut is a hole in the mouth mask: it hides the upturned end of the upper
   * line, so growing it flattens the smile into a frown. The cuts are ellipses
   * whose horizontal size follows the mouth width; only their height changes
   * with the expression.
   *
   * `centre` and `radiusX` are for the viewer's left cut; the right one mirrors
   * around x = 960. `happy` is the flat sliver both Happiness references use,
   * `sad` the full disc both Sadness references use.
   */
  corner: {
    /** Top of the cut, at the narrow and wide mouths (the sliver drops 4 units
     * at the narrow reference). */
    top: { min: 667.644, max: 663.595 },
    /** Horizontal centre, at the narrow and wide mouths. */
    centre: { min: 799.8955, max: 706.903 },
    /** Horizontal radius, at the narrow and wide mouths. */
    radiusX: { min: 83.5215, max: 130.051 },
    /** Vertical radius of the flat happy cut, at the narrow and wide mouths. */
    happyRadiusY: { min: 8.6805, max: 10.705 },
    /** Vertical radius of the round sad cut. */
    sadRadiusY: 51.668,
  },

  /**
   * Resting pose: a neutral, shut mouth with its corners showing. The reference
   * extremes are reached from here in both directions: a smile widens to the Max
   * width and a frown narrows to the Min width, so the tiny Min mouth is an
   * expression rather than the default face.
   *
   * `open` is 0 — the shut end of the range — so a relaxed face reads as a closed
   * mouth. The eased open curve lifts it well off the shut reference with the
   * first small bit of jaw travel, so rest does not cost any responsiveness.
   *
   * `bottomWidth` 0.33587786 is a lower lip of exactly the default width: the
   * rig maps 0..1 onto 0.692..1.609, and (1 - 0.692) / (1.609 - 0.692) is that.
   */
  rest: { open: 0, width: 0.5, bottomWidth: 0.33587786, corner: 0.5 },
} as const;

export interface ShapeDef {
  /** Bone that owns the shape; also its id in the skeleton debug view. */
  bone: BoneId;
  paint: Paint;
  /** Optional outline drawn over the filled path, in artboard units. */
  stroke?: { color: string; width: number; alpha?: number };
  /** SVG path data in artboard units. */
  d: string;
}

/** One corner cut in artboard units, for the viewer's left corner. */
export interface MouthCornerShape {
  centre: number;
  centreY: number;
  radiusX: number;
  radiusY: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * The corner cut for a mouth width (0 = narrow, 1 = wide) and expression
 * (-1 = full sad disc, 0 = flat happy sliver, 1 = no cut).
 *
 * This is the whole of the corner rig's geometry, kept pure so the reference
 * extremes can be checked without a renderer. The right corner mirrors `centre`
 * around the middle of the artboard.
 */
export function mouthCornerShape(width: number, corner: number): MouthCornerShape {
  const amount = clamp(width, 0, 1);
  const value = clamp(corner, -1, 1);
  const happyRadiusY = lerp(
    MOUTH.corner.happyRadiusY.min,
    MOUTH.corner.happyRadiusY.max,
    amount,
  );
  const happyTop = lerp(MOUTH.corner.top.min, MOUTH.corner.top.max, amount);
  const radiusY =
    value >= 0
      ? happyRadiusY * (1 - value)
      : lerp(happyRadiusY, MOUTH.corner.sadRadiusY, -value);
  // The sad cut reaches higher than the narrow happy sliver; both references
  // put it at the top of the wide sliver.
  const top = value >= 0 ? happyTop : lerp(happyTop, MOUTH.corner.top.max, -value);

  return {
    centre: lerp(MOUTH.corner.centre.min, MOUTH.corner.centre.max, amount),
    centreY: top + radiusY,
    radiusX: lerp(MOUTH.corner.radiusX.min, MOUTH.corner.radiusX.max, amount),
    radiusY,
  };
}

/**
 * The lower lip's Y scale for an open pose.
 *
 * The reference range scales the lip about its top edge, which leaves the first
 * ~27% of the travel hidden behind the fixed gap: the mouth appears not to open
 * until the pose is already a third of the way up. The scale is eased out
 * instead, so the visible lip starts moving almost immediately while the two
 * endpoint references (`MinMouthOpen` and `MaxMouthOpen`) keep their exact
 * scales.
 */
export function mouthOpenScale(open: number): number {
  const value = clamp(open, 0, 1);
  const eased = 1 - (1 - value) ** 2;
  return lerp(MOUTH.open.min, MOUTH.open.max, eased);
}

/**
 * The lower lip's X scale for a bottom-width pose and an open pose.
 *
 * A lip wider than the default reaches past the gap's corner arms when the
 * mouth is nearly shut, and the excess would show above the upper line as a
 * bump at each corner. The extra width therefore fades in with the opening. The
 * BottomWidth references are all fully open, so they still reproduce exactly.
 */
export function mouthBottomScale(bottom: number, open: number): number {
  const scale = lerp(MOUTH.bottomWidth.min, MOUTH.bottomWidth.max, clamp(bottom, 0, 1));
  const opening = clamp(open, 0, 1);
  return scale > 1 ? 1 + (scale - 1) * opening * opening : scale;
}

/**
 * One shape per bone. Draw order follows the source file: the eye shells and
 * their irises first, then the thin slashes that cut the shells (cheeks and
 * brows), and finally the smile. The synth line is not here: it is generated
 * from the microphone.
 */
export const SHAPES: readonly ShapeDef[] = [
  {
    bone: "eyeLeftShell",
    paint: PAINT.shell,
    d: "M226.714 174.193 C284.422 162.588 495.981 129.199 602.612 237.204 C724.565 360.727 752.246 533.805 666.48 627.861 C663.426 631.211 659.331 633.544 654.763 634.538 C612.264 643.785 383.291 687.035 270.896 573.192 C164.158 465.08 197.295 250.476 208.72 192.278 C210.51 183.162 217.612 176.023 226.714 174.193 Z",
  },
  {
    bone: "eyeRightShell",
    paint: PAINT.shell,
    d: "M1693.286 174.193 C1635.578 162.588 1424.019 129.199 1317.388 237.204 C1195.435 360.727 1167.754 533.805 1253.52 627.861 C1256.574 631.211 1260.669 633.544 1265.237 634.538 C1307.736 643.785 1536.709 687.035 1649.104 573.192 C1755.842 465.08 1722.705 250.476 1711.28 192.278 C1709.49 183.162 1702.388 176.023 1693.286 174.193 Z",
  },
  {
    bone: "eyeLeftIris",
    paint: PAINT.iris,
    stroke: { color: FACE.iris.rim, width: 3, alpha: 0.38 },
    d: "M375.927 412.083 C375.927 293.244 442.017 196.906 523.542 196.906 C605.068 196.906 671.157 293.244 671.157 412.083 C671.157 530.922 605.068 627.261 523.542 627.261 C442.017 627.261 375.927 530.922 375.927 412.083 Z",
  },
  {
    bone: "eyeLeftPupil",
    paint: PAINT.pupil,
    d: "M483.547 412.083 C483.547 349.153 501.454 298.137 523.542 298.137 C545.631 298.137 563.537 349.153 563.537 412.083 C563.537 475.014 545.631 526.03 523.542 526.03 C501.454 526.03 483.547 475.014 483.547 412.083 Z",
  },
  {
    bone: "eyeRightIris",
    paint: PAINT.iris,
    stroke: { color: FACE.iris.rim, width: 3, alpha: 0.38 },
    d: "M1248.843 412.083 C1248.843 293.244 1314.932 196.906 1396.458 196.906 C1477.983 196.906 1544.073 293.244 1544.073 412.083 C1544.073 530.922 1477.983 627.261 1396.458 627.261 C1314.932 627.261 1248.843 530.922 1248.843 412.083 Z",
  },
  {
    bone: "eyeRightPupil",
    paint: PAINT.pupil,
    d: "M1356.463 412.083 C1356.463 349.153 1374.369 298.137 1396.458 298.137 C1418.546 298.137 1436.453 349.153 1436.453 412.083 C1436.453 475.014 1418.546 526.03 1396.458 526.03 C1374.369 526.03 1356.463 475.014 1356.463 412.083 Z",
  },
  {
    bone: "cheekLeft",
    paint: PAINT.line,
    d: "M134.16 654.458 C202.985 652.579 434.564 647.036 584.649 652.913 C761.971 659.856 839.926 672.038 759.443 680.174 C758.884 680.231 758.318 680.268 757.746 680.285 C740.362 680.813 460.526 689.124 288.167 682.375 C193.598 678.673 150.417 671.182 130.713 664.975 C124.95 663.159 127.744 654.633 134.16 654.458 Z",
  },
  {
    bone: "cheekRight",
    paint: PAINT.line,
    d: "M1785.84 654.458 C1717.015 652.579 1485.436 647.036 1335.351 652.913 C1158.029 659.856 1080.074 672.038 1160.557 680.174 C1161.116 680.231 1161.682 680.268 1162.254 680.285 C1179.638 680.813 1459.474 689.124 1631.833 682.375 C1726.402 678.673 1769.583 671.182 1789.287 664.975 C1795.05 663.159 1792.256 654.633 1785.84 654.458 Z",
  },
  {
    bone: "browLeft",
    paint: PAINT.line,
    d: "M134.16 129.566 C202.985 127.687 434.564 122.144 584.649 128.021 C761.971 134.964 839.926 147.146 759.443 155.282 C758.884 155.339 758.318 155.376 757.746 155.393 C740.362 155.921 460.526 164.232 288.167 157.483 C193.598 153.781 150.417 146.29 130.713 140.083 C124.95 138.267 127.744 129.741 134.16 129.566 Z",
  },
  {
    bone: "browRight",
    paint: PAINT.line,
    d: "M1785.84 129.566 C1717.015 127.687 1485.436 122.144 1335.351 128.021 C1158.029 134.964 1080.074 147.146 1160.557 155.282 C1161.116 155.339 1161.682 155.376 1162.254 155.393 C1179.638 155.921 1459.474 164.232 1631.833 157.483 C1726.402 153.781 1769.583 146.29 1789.287 140.083 C1795.05 138.267 1792.256 129.741 1785.84 129.566 Z",
  },
  // The smile's two halves ride on separate bones: the lower lip can open and
  // change width without moving the upper line. The mask that cuts the mouth
  // shape is built by the rig from MOUTH.cutout and the corner covers.
  {
    bone: "mouthBottom",
    paint: PAINT.shell,
    d: MOUTH.bottom,
  },
  {
    bone: "mouthTop",
    paint: PAINT.shell,
    d: MOUTH.top,
  },
];
